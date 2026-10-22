import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hash, randomId, safeError, sleep, summary, VERSION } from './common.mjs';
import { questionMessage, resolveReply } from './store.mjs';
import { continuationCommand, taskList } from './tasks.mjs';
import { API_BASE, trustedBase } from './wechat.mjs';

export class Bridge extends EventEmitter {
  constructor({ store, api, vault, clock = Date.now, titleLookup = () => '', sessionLookup = () => null }) {
    super(); Object.assign(this, { store, api, vault, clock, titleLookup, sessionLookup });
    this.creds = null; this.login = null; this.closed = false; this.sending = false;
    this.error = null; this.abort = new AbortController(); this.vaultQueue = Promise.resolve();
  }
  async init() { this.creds = await this.vault.load(); return this; }
  async persist() {
    const snapshot = structuredClone(this.creds);
    const save = this.vaultQueue.catch(() => {}).then(() => this.vault.save(snapshot));
    this.vaultQueue = save; await save;
  }
  ready() { return !!(this.creds?.peer && this.creds?.contextToken && !this.creds.invalid && !this.paused() && this.clock() >= (this.blockedUntil || 0)); }
  paused() { return this.store.meta('paused') === 'true'; }
  routingTasks() { return this.store.tasks().map(t => { const meta = this.sessionLookup(t.session_id); return meta?.root && !meta.archived ? t : {...t,state:'archived'}; }); }
  status() {
    const pending = this.store.pending().map(r => ({ id: r.id, title: r.title, session: r.session_id, created: r.created, expires: r.expires,
      questions: r.questions.map(q => ({ ...q, answered: !!r.answers[q.id] })) }));
    return { version: VERSION, paired: !!this.creds, ready: this.ready(), paused: this.paused(),
      needs_activation: !!this.creds && !this.creds.contextToken, needs_login: !!this.creds?.invalid,
      account: this.creds ? hash(this.creds.peer).slice(0, 8) : null, last_inbound: this.creds?.lastInbound || null,
      error: this.error, login: this.login ? { id: this.login.id, status: this.login.status, started: this.login.started } : null,
      pending, tasks: this.store.tasks().map(({number,title,state}) => ({number,title,state})),
      desktop_connector: { ready: !!this.desktop?.ready() }, ...this.store.stats() };
  }
  async startLogin() {
    if (this.login && this.clock() - this.login.started < 300000 && !['expired', 'confirmed', 'failed', 'verify_code_blocked'].includes(this.login.status)) return this.status().login;
    const result = await this.api.startLogin(this.creds?.token ? [this.creds.token] : []);
    if (!result.qrcode || !result.qrcode_img_content) throw Object.assign(new Error('微信未返回完整二维码'), { code: 'INVALID_QR_RESPONSE' });
    this.login = { id: randomId(), qrcode: result.qrcode, qrUrl: result.qrcode_img_content, status: 'wait', started: this.clock(), base: API_BASE };
    this.pollLogin(this.login).catch(e => { this.error = safeError(e); this.store.audit('login_error', safeError(e)); });
    return this.status().login;
  }
  async pollLogin(login) {
    while (!this.closed && this.login === login && this.clock() - login.started < 300000) {
      if (login.status === 'need_verifycode' && !login.verifyCode) { await sleep(500); continue; }
      let result;
      try { result = await this.api.pollLogin(login.qrcode, login.base, login.verifyCode, this.abort.signal); }
      catch (e) { this.error = safeError(e); await sleep(2000); continue; }
      login.status = result.status;
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_user_id || !result.ilink_bot_id) { login.status = 'failed'; throw Object.assign(new Error('微信账号资料不完整'), { code: 'INVALID_LOGIN_RESPONSE' }); }
        const peer = String(result.ilink_user_id);
        if (this.creds && this.creds.peer !== peer) for (const r of this.store.pending()) this.store.cancel(r.id, 'cancelled');
        this.creds = { token: result.bot_token, botId: result.ilink_bot_id, peer, base: trustedBase(result.baseurl || API_BASE), cursor: '', contextToken: '', lastInbound: 0, invalid: false };
        await this.persist(); this.error = null; this.store.audit('wechat_paired', { account: hash(peer).slice(0, 8) }); this.emit('changed'); return;
      }
      if (result.status === 'scaned_but_redirect') {
        if (result.redirect_host) login.base = trustedBase(result.redirect_host.includes('://') ? result.redirect_host : `https://${result.redirect_host}`);
      } else if (result.status === 'binded_redirect') {
        login.status = this.creds ? 'confirmed' : 'failed'; return;
      } else if (['expired', 'verify_code_blocked'].includes(result.status)) return;
      else if (result.status === 'scaned') login.verifyCode = undefined;
      else if (!['wait', 'need_verifycode'].includes(result.status)) { login.status = 'failed'; return; }
      await sleep(500);
    }
    if (this.login === login && login.status !== 'confirmed') login.status = 'expired';
  }
  async receive(message) {
    if (!this.creds || message.from_user_id !== this.creds.peer || Number(message.message_type) !== 1) return { ignored: true };
    const id = hash(`${message.from_user_id}:${message.message_id || JSON.stringify([message.seq, message.create_time_ms, message.item_list])}`);
    if (!this.store.acceptInbound(id)) return { duplicate: true };
    if (message.context_token) {
      this.creds.contextToken = message.context_token; this.creds.lastInbound = this.clock();
      this.creds.invalid = false; this.blockedUntil = 0; await this.persist(); this.store.reactivate(this.creds.peer); this.error = null;
    }
    const text = (message.item_list || []).filter(x => Number(x.type) === 1).map(x => x.text_item?.text || '').join('\n').trim();
    if (!text) return { ignored: true };
    const pending = this.store.pending(), tasks = this.routingTasks();
    const command = text.replace(/^\//, '').toLowerCase();
    let receipt;
    if (['激活', '连接', 'ping', '收到', '帮助', 'help', '状态', 'status'].includes(command)) {
      receipt = `Codex 微信通道已激活。${pending.length ? `当前有 ${pending.length} 组待答问题，发送「待答」查看。` : '当前没有待答问题。'}\n完成通知仅限主任务。发送「/任务」查看任务；「/任务号 下一步要求」续办。普通文字只回答待答问题。`;
      this.store.meta('live_inbound_verified', 'true');
    } else if (['待答', 'pending'].includes(command)) {
      receipt = pending.length ? pending.flatMap(r => r.questions.filter(q => !r.answers[q.id]).map(q => `第${q.number}题｜${r.title || 'Codex'}：${q.question}`)).join('\n').slice(0, 3000) : '当前没有待答问题。';
    } else if (continuationCommand(text, tasks)) {
      const command = continuationCommand(text, tasks);
      if (command.list) receipt = taskList(tasks);
      else if (command.error) receipt = command.error;
      else {
        const meta = this.sessionLookup(command.task.session_id);
        if (!meta?.root || meta.archived) receipt = `任务 ${command.task.number} 的原聊天当前不可续办，尚未提交。请回 Codex 查看。`;
        else if (Number(message.create_time_ms) && Number(message.create_time_ms) < command.task.completed - 5000) receipt = `这条消息早于任务 ${command.task.number} 本次完成，尚未提交。请重新发送下一步要求。`;
        else if (!this.desktop?.ready()) receipt = `已识别任务 ${command.task.number}，但桌面续办入口尚未连接，尚未提交。请重新打开 Codex，并在微信通道连接后重发本条。`;
        else {
          const job = this.store.enqueueContinuation(command.task, command.prompt, id);
          receipt = job ? `已收到任务 ${command.task.number} 的下一步要求，正在投递原聊天；投递结果会另行通知。` : '该任务已在处理，请等待投递结果。';
        }
      }
    } else {
      const resolved = resolveReply(pending, text, Number(message.create_time_ms) || this.clock());
      if (resolved.ok && this.store.answer(resolved.request.id, resolved.question, resolved.answer, id)) {
        const after = this.store.request(resolved.request.id);
        receipt = `已记录第${resolved.question.number}题。${after.status === 'answered' ? '答案正在返回原聊天。' : '请继续回答其他问题。'}`;
        this.store.meta('live_answer_verified', 'true'); this.emit('answer', resolved.request.id);
      } else receipt = resolved.reason || '这道问题已处理，未重复提交。';
    }
    this.store.enqueue({ key: `receipt:${id}`, kind: 'receipt', peer: this.creds.peer, text: receipt, ttl_ms: 3600000 });
    return { accepted: true };
  }
  async pollOnce() {
    if (!this.creds || this.creds.invalid) return;
    const active = this.creds;
    const result = await this.api.updates(active, active.cursor || '', this.abort.signal);
    if (this.creds !== active) return;
    for (const msg of result.msgs || []) {
      this.store.audit('inbound_observed', { owner_match: msg.from_user_id === this.creds.peer, message_type: msg.message_type ?? null,
        has_context: !!msg.context_token, has_text: (msg.item_list || []).some(x => Number(x.type) === 1 && !!x.text_item?.text) });
      await this.receive(msg);
    }
    if (result.get_updates_buf && result.get_updates_buf !== this.creds.cursor) { this.creds.cursor = result.get_updates_buf; await this.persist(); }
  }
  async pollLoop() {
    let backoff = 1000;
    while (!this.closed) {
      if (!this.creds || this.creds.invalid) { await sleep(1000); continue; }
      try { await this.pollOnce(); backoff = 1000; await sleep(250); }
      catch (e) {
        if (this.closed) break;
        this.error = safeError(e); this.store.audit('poll_error', safeError(e));
        if (e.expired) { this.creds.invalid = true; this.creds.contextToken = ''; await this.persist(); }
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
  async drainOnce() {
    if (this.sending || !this.ready()) return;
    const record = this.store.next(this.creds.peer); if (!record) return;
    this.sending = true; this.store.sending(record.id);
    try {
      await this.api.send(this.creds, record.text, record.client_id, this.abort.signal);
      this.store.sent(record.id); this.error = null; this.store.audit('message_sent', { id: record.id, kind: record.kind });
      if (record.kind === 'test') this.store.meta('live_outbound_verified', 'true');
    } catch (e) {
      const state = e.uncertain ? 'uncertain' : e.deferred ? 'deferred' : 'failed';
      this.store.failed(record.id, state, String(e.code || 'SEND_FAILED'));
      this.error = safeError(e); this.store.audit('message_failed', { id: record.id, kind: record.kind, state, ...safeError(e) });
      this.blockedUntil = this.clock() + 30000;
      if (record.kind === 'question') { this.store.cancel(record.request_id, 'unavailable'); this.emit('changed'); }
      if (e.deferred) { this.creds.contextToken = ''; if (e.expired) this.creds.invalid = true; await this.persist(); }
    } finally { this.sending = false; }
  }
  ask(args) {
    if (!this.ready()) throw Object.assign(new Error('微信尚未就绪。请在 Codex 内直接提问；可在本机管理页绑定，或在微信发送“激活”。'), { code: 'WECHAT_UNAVAILABLE', status: 409 });
    const existing = this.store.byKey(args.request_key); if (existing) return existing;
    if (this.store.pending().length >= 100) throw Object.assign(new Error('待答问题过多'), { status: 429, code: 'TOO_MANY_PENDING' });
    const request = this.store.createRequest(args);
    for (const q of request.questions) this.store.enqueue({ key: `question:${request.id}:${q.id}`, kind: 'question', request_id: request.id, peer: this.creds.peer, text: questionMessage(request, q) });
    return request;
  }
  notify(payload) {
    if (payload.type !== 'agent-turn-complete') return { ignored: true };
    const session = String(payload['thread-id'] || ''), turn = String(payload['turn-id'] || '');
    if (!session) return { ignored: true };
    // Trust local session metadata as well as explicit hook fields. A child Stop
    // event can never allocate a task number or send a completion summary.
    const info = this.sessionLookup(session);
    if (payload.agent_id || payload.agent_type || payload.parent_thread_id || !info?.root) return { suppressed: 'not_main_task' };
    this.store.session(session, String(payload.cwd || ''));
    if (this.store.pending().some(r => r.session_id === session && (!r.turn_id || r.turn_id === turn))) return { suppressed: 'waiting_for_answer' };
    const meta = this.store.sessionTitle(session);
    const title = summary(info.title || this.titleLookup(session) || meta?.title || path.win32.basename(meta?.cwd || '') || `聊天 ${session.slice(0, 8)}`, 40);
    const key = turn || hash(summary(payload['last-assistant-message']));
    const completion = this.store.completeTask(session, key, title, info.cwd || meta?.cwd || '');
    if (completion.duplicate) return { duplicate: true };
    if (!this.creds || this.paused()) { this.store.audit('completion_not_forwarded', { reason: this.paused() ? 'paused' : 'not_paired', session: hash(session).slice(0, 8) }); return { skipped: true }; }
    const text = `【任务 ${completion.task.number}｜${title}｜本轮结束】\n${summary(payload['last-assistant-message']) || '本轮已结束，请回 Codex 查看结果。'}\n下一步可发：/${completion.task.number} 继续任务\n只有一个可续办任务时，也可发 /继续任务。`;
    return this.store.enqueue({ key: `completion:${session}:${key}`, peer: this.creds.peer, text });
  }
  event(data) {
    if (data.kind === 'notify') return this.notify(data.payload || {});
    if (data.event === 'SessionStart') { this.store.session(data.session_id, data.cwd || '', data.title || ''); this.store.audit('hook_session_start'); }
    if (['Interrupt', 'SessionEnd'].includes(data.event)) { this.store.cancelSession(data.session_id, data.turn_id || ''); this.emit('changed'); }
    return { ok: true };
  }
  async close() {
    this.closed = true; this.abort.abort();
    for (let i = 0; i < 250 && this.sending; i++) await sleep(20);
    await this.vaultQueue.catch(() => {});
  }
}
