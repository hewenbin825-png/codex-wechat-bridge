import path from 'node:path';
import { EventEmitter } from 'node:events';
import { hash, randomId, safeError, sleep, summary, VERSION } from './common.mjs';
import { questionMessage, resolveReply } from './store.mjs';
import { clearCommand, continuationCommand, taskList } from './tasks.mjs';
import { API_BASE, trustedBase } from './wechat.mjs';

export class Bridge extends EventEmitter {
  constructor({ store, api, vault, clock = Date.now, titleLookup = () => '', sessionLookup = () => null,desktopWaitMs=15000 }) {
    super(); Object.assign(this, { store, api, vault, clock, titleLookup, sessionLookup,desktopWaitMs });
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
  status(session = '') {
    const pending = this.store.pending().filter(r=>!session||r.session_id===session).map(r => ({ id: r.id, title: r.title, session: r.session_id, created: r.created, expires: r.expires,
      questions: r.questions.map(q => ({ ...q, answered: !!r.answers[q.id] })) }));
    return { version: VERSION, paired: !!this.creds, ready: this.ready(), paused: this.paused(),
      needs_activation: !!this.creds && !this.creds.contextToken, needs_login: !!this.creds?.invalid,
      account: this.creds ? hash(this.creds.peer).slice(0, 8) : null, last_inbound: this.creds?.lastInbound || null,
      error: this.error, login: this.login ? { id: this.login.id, status: this.login.status, started: this.login.started } : null,
      chat_mode:session?this.store.chatMode(session):null, question_presentation:session&&this.store.chatMode(session)==='wechat'?'chat_text':'codex_native',
      pending, tasks: this.store.tasks().filter(t=>!session||t.session_id===session).map(({number,title,state}) => ({number,title,state})),
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
    const pending = this.store.pending().filter(r=>this.store.chatMode(r.session_id)==='wechat'), tasks = this.routingTasks();
    const command = text.replace(/^\//, '').toLowerCase();
    let receipt;const clearing=clearCommand(text),createdAt=Number(message.create_time_ms)||this.clock(),resetAt=Number(this.store.meta('question_reset_at')||0);
    if(clearing){
      if(clearing.error)receipt=clearing.error;
      else if(resetAt&&createdAt<resetAt)receipt='这是清理前的旧 /clear 消息，未再次清理当前问题。';
      else {const cleared=this.store.clearQuestions();this.emit('changed');receipt=`已清空题号和任务号，取消 ${cleared.pending_questions} 道待答问题。下一道问题和下一个新分配的任务都从 1 开始。\n旧题号和旧任务号入口已失效，未投递的编号提示词已取消。请只使用清理后新消息里的编号。工作聊天、历史和完成去重记录保留，已执行中的工作继续。`;}
    } else if (['激活', '连接', 'ping', '收到', '帮助', 'help', '状态', 'status'].includes(command)) {
      receipt = `Codex 微信通道已激活。${pending.length ? `当前有 ${pending.length} 组待答问题，发送「待答」查看。` : '当前没有待答问题。'}\n完成通知仅限主任务。发送「/任务」查看任务；「/任务号 下一步要求」续办；「/clear」重置题号和任务号。发送「/艾莉丝 对话」聊天；「/艾莉丝 创建任务 具体要求」才建立任务。连续对话中普通文字仍优先回答待答问题。`;
      this.store.meta('live_inbound_verified', 'true');
    } else if (['待答', 'pending'].includes(command)) {
      receipt = pending.length ? pending.flatMap(r => r.questions.filter(q => !r.answers[q.id]).map(q => `第${q.number}题｜${r.title || 'Codex'}：${q.question}`)).join('\n').slice(0, 3000) : '当前没有待答问题。';
    } else if (/^\/(?:艾莉丝|爱莉丝|dot|新任务)(?:\s|$)/i.test(text)) {
      receipt=this.dot?.receive(text,id)||'Dot 事件连接尚未就绪，这条新需求尚未提交。';
    } else if (continuationCommand(text, tasks)) {
      const command = continuationCommand(text, tasks);
      if (command.list) receipt = taskList(tasks);
      else if (command.error) receipt = command.error;
      else if(Number(this.store.meta('task_reset_at')||0)>createdAt)receipt='这条任务提示词早于 /clear，未投递。请使用清理后新通知中的任务号。';
      else {
        const meta = this.sessionLookup(command.task.session_id);
        if (!meta?.root || meta.archived) receipt = `任务 ${command.task.number} 的原聊天当前不可续办，尚未提交。请回 Codex 查看。`;
        else if (Number(message.create_time_ms) && Number(message.create_time_ms) < command.task.completed - 5000) receipt = `这条消息早于任务 ${command.task.number} 本次完成，尚未提交。请重新发送下一步要求。`;
        else if (!await this.awaitDesktop()) receipt = `已识别任务 ${command.task.number}，但桌面续办入口尚未连接，尚未提交。请重新打开 Codex，并在微信通道连接后重发本条。`;
        else {
          const current=this.store.taskForSession(command.task.session_id);
          const job = current?.number===command.task.number&&createdAt>=Number(this.store.meta('task_reset_at')||0)?this.store.enqueueContinuation(current,command.prompt,id):null;
          receipt = job ? `已收到任务 ${command.task.number} 的下一步要求，正在投递原聊天；投递结果会另行通知。` : '该任务已在处理，请等待投递结果。';
        }
      }
    } else if(resetAt&&createdAt<resetAt){
      receipt='这条回复早于 /clear，旧题号已失效，未投递到新问题。请使用清理后显示的新题号。';
    } else {
      const resolved = resolveReply(pending, text, Number(message.create_time_ms) || this.clock());
      if (resolved.ok && this.store.answer(resolved.request.id, resolved.question, resolved.answer, id)) {
        const after = this.store.request(resolved.request.id);
        receipt = `已记录第${resolved.question.number}题。${after.status === 'answered' ? '答案正在返回原聊天。' : '请继续回答其他问题。'}\n后续补充仍可发送「${resolved.question.number}.补充内容」。`;
        this.store.meta('live_answer_verified', 'true'); this.emit('answer', resolved.request.id);
      } else {
        const supplement=await this.questionSupplement(text,id,Number(message.create_time_ms)||this.clock());
        const numbered=/^[（(]?\s*\d+(?:\s*[.．。，,]|\s*[）)]?$)/.test(text);
        receipt=supplement||(!pending.length&&!numbered&&!text.startsWith('/')&&this.dot?.dialogueActive()?this.dot.receiveConversation(text,id):null)||resolved.reason||'这道问题已处理，未重复提交。';
      }
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
  async awaitDesktop(){
    if(!this.desktop)return false;
    const deadline=Date.now()+Math.max(0,this.desktopWaitMs);
    while(!this.closed&&!this.desktop.ready()&&Date.now()<deadline)await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
    return !this.closed&&this.desktop.ready();
  }
  async questionSupplement(raw,inbound,createdAt) {
    let text=String(raw).trim();if(/^[（(][\s\S]*[）)]$/.test(text))text=text.slice(1,-1).trim();
    const match=/^(\d+)\s*[.．。]\s*([\s\S]+)$/.exec(text);
    if(!match||/^\d+$/.test(match[2].trim()))return null;
    const found=this.store.questionByNumber(Number(match[1]));if(!found)return null;
    const {request,question}=found,prompt=match[2].trim();
    if(this.store.chatMode(request.session_id)!=='wechat')return '该原聊天已关闭微信模式，请在电脑原聊天补充。';
    if(!request.answers[question.id]||!['pending','answered'].includes(request.status))return null;
    if(prompt.length>8000)return '补充内容不能超过 8000 字符。';
    if(createdAt<request.answers[question.id].received_at-5000)return '这条补充早于已记录答案，尚未提交。请重新发送。';
    const meta=this.sessionLookup(request.session_id);
    if(!meta?.root||meta.archived)return `第${question.number}题的原聊天当前不可用，补充尚未提交。`;
    if(!await this.awaitDesktop())return `已识别第${question.number}题的补充，但桌面连接未就绪，尚未提交。连接后请重发。`;
    if(this.store.questionByNumber(question.number)?.request.id!==request.id||!['pending','answered'].includes(this.store.request(request.id)?.status))return '该题已取消或编号已清理，补充尚未提交。';
    const job=this.store.enqueueQuestionSupplement(request,question,prompt,inbound);
    return job?`已收到第${question.number}题的后续补充，正在投递原聊天；结果会另行通知。`:'这条补充已处理，未重复提交。';
  }
  answerLocal(requestId,{question_id,choice,text,source='local'}) {
    this.store.sweep();
    const request=this.store.request(requestId),question=request?.questions.find(q=>q.id===question_id);
    if(!request||!question)throw Object.assign(new Error('问题不存在'),{status:404});
    if(request.status!=='pending'||request.answers[question.id])return {accepted:false,reason:'这道题已回答、取消或过期，原答案保持不变。',request};
    let answer;
    if(typeof text==='string'&&text.trim())answer=text.trim();
    else if(Number.isInteger(choice)&&choice>=1&&choice<=question.options.length)answer=question.options[choice-1].label;
    if(!answer||answer.length>8000)throw Object.assign(new Error('请选择选项或填写 1–8000 字符的自定义答案'),{status:400});
    if(!['local','codex'].includes(source))throw Object.assign(new Error('回答来源无效'),{status:400});
    const accepted=this.store.answer(requestId,question,answer,randomId(),source);
    if(accepted){
      if(this.creds&&this.store.chatMode(request.session_id)==='wechat')this.store.enqueue({key:`local-answer:${requestId}:${question.id}`,kind:'receipt',session_id:request.session_id,peer:this.creds.peer,text:`第${question.number}题已在电脑端回答。后续可发送「${question.number}.补充内容」。`,ttl_ms:3600000});
      this.emit('answer',requestId);
    }
    return {accepted,request:this.store.request(requestId)};
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
    this.store.retryRateLimited(this.creds.peer);
    const record = this.store.next(this.creds.peer); if (!record) return;
    const sourceSession=record.session_id||(record.kind==='question'?this.store.request(record.request_id)?.session_id:record.kind==='completion'?/^completion:([^:]+):/.exec(record.event_key)?.[1]:'');
    if((sourceSession&&this.store.chatMode(sourceSession)!=='wechat')||(record.kind==='completion'&&!sourceSession)||(record.kind==='question'&&this.store.request(record.request_id)?.presentation!=='chat_text')){
      this.store.failed(record.id,'cancelled','CHAT_MODE_DISABLED');return;
    }
    this.sending = true; this.store.sending(record.id);
    const activeCreds=this.creds, sentContext=activeCreds.contextToken;
    try {
      await this.api.send(this.creds, record.text, record.client_id, this.abort.signal);
      this.store.sent(record.id); this.error = null; this.store.audit('message_sent', { id: record.id, kind: record.kind });
      if (record.kind === 'test') this.store.meta('live_outbound_verified', 'true');
    } catch (e) {
      const state = e.uncertain ? 'uncertain' : e.deferred ? 'deferred' : 'failed';
      this.store.failed(record.id, state, String(e.code || 'SEND_FAILED'));
      this.error = safeError(e); this.store.audit('message_failed', { id: record.id, kind: record.kind, state, ...safeError(e) });
      this.blockedUntil = this.clock() + 30000;
      if (record.kind === 'question') { if(!this.store.request(record.request_id)?.local_available)this.store.cancel(record.request_id, 'unavailable'); this.emit('changed'); }
      if ((e.expired || e.contextInvalid) && this.creds===activeCreds && this.creds.contextToken===sentContext) {
        this.creds.contextToken = ''; if (e.expired) this.creds.invalid = true; await this.persist();
      }
    } finally { this.sending = false; }
  }
  ask(args) {
    if(this.store.chatMode(args.session_id)!=='wechat')throw Object.assign(new Error('This chat uses original Codex questions. Enable WeChat only after an explicit request in this chat.'),{code:'CHAT_MODE_NATIVE',status:409});
    if(args.presentation!=='chat_text')throw Object.assign(new Error('Reload the WeChat MCP connection for text-only questions; native bridge forms are no longer used.'),{code:'CLIENT_RELOAD_REQUIRED',status:409});
    if (!this.ready()&&!args.local_available) throw Object.assign(new Error('微信尚未就绪。请在 Codex 内直接提问；可在本机管理页绑定，或在微信发送“激活”。'), { code: 'WECHAT_UNAVAILABLE', status: 409 });
    const existing = this.store.byKey(args.request_key); if (existing) {if(existing.session_id!==args.session_id)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT',status:403});return existing;}
    if (this.store.pending().length >= 100) throw Object.assign(new Error('待答问题过多'), { status: 429, code: 'TOO_MANY_PENDING' });
    const request = this.store.createRequest(args);
    if(this.creds)for (const q of request.questions) this.store.enqueue({ key: `question:${request.id}:${q.id}`, kind: 'question', request_id: request.id, session_id:request.session_id,peer: this.creds.peer, text: questionMessage(request, q) });
    return request;
  }
  setChatMode({session_id,mode}) {
    const meta=this.sessionLookup(session_id);
    if(!meta?.root||meta.archived)throw Object.assign(new Error('A current root chat is required'),{code:'INVALID_CHAT',status:403});
    const result=this.store.setChatMode(session_id,mode);this.emit('changed');return {...result,question_presentation:mode==='wechat'?'chat_text':'codex_native'};
  }
  answerFromChat({session_id,request_id,question_id,text}) {
    const request=this.store.request(request_id);
    if(!request||request.session_id!==session_id)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT',status:403});
    const question=request.questions.find(q=>q.id===question_id);
    if(!question)throw Object.assign(new Error('Unknown question'),{code:'UNKNOWN_QUESTION',status:404});
    if(request.status!=='pending'||request.answers[question.id])return {accepted:false,request};
    const resolved=resolveReply([{...request,questions:[question]}],text,this.clock());
    if(!resolved.ok)throw Object.assign(new Error(resolved.reason),{code:'INVALID_ANSWER',status:400});
    return this.answerLocal(request_id,{question_id,text:resolved.answer,source:'codex'});
  }
  notify(payload) {
    if (payload.type !== 'agent-turn-complete') return { ignored: true };
    const session = String(payload['thread-id'] || ''), turn = String(payload['turn-id'] || '');
    if (!session) return { ignored: true };
    // Trust local session metadata as well as explicit hook fields. A child Stop
    // event can never allocate a task number or send a completion summary.
    const info = this.sessionLookup(session);
    if (payload.agent_id || payload.agent_type || payload.parent_thread_id || !info?.root) return { suppressed: 'not_main_task' };
    if(this.store.chatMode(session)!=='wechat'){
      // Record only turn identity/state, never its text or a new task number.
      // This also handles a very fast Dot job that finishes before binding.
      this.store.completeTask(session,turn||hash(summary(payload['last-assistant-message'])),summary(info.title||'Codex 工作',40),info.cwd||'',{allocate:false});
      return {suppressed:'chat_mode_native'};
    }
    this.store.session(session, String(payload.cwd || ''));
    if (this.store.pending().some(r => r.session_id === session && (r.presentation==='chat_text'||!r.turn_id||r.turn_id===turn))) return { suppressed: 'waiting_for_answer' };
    const meta = this.store.sessionTitle(session);
    const title = summary(info.title || this.titleLookup(session) || meta?.title || path.win32.basename(meta?.cwd || '') || `聊天 ${session.slice(0, 8)}`, 40);
    const key = turn || hash(summary(payload['last-assistant-message']));
    const completion = this.store.completeTask(session, key, title, info.cwd || meta?.cwd || '');
    if (completion.duplicate) return { duplicate: true };
    try{this.dot?.completed(session,key,payload['last-assistant-message']);}catch(e){this.store.audit('dot_completion_event_error',safeError(e));}
    if (!this.creds || this.paused()) { this.store.audit('completion_not_forwarded', { reason: this.paused() ? 'paused' : 'not_paired', session: hash(session).slice(0, 8) }); return { skipped: true }; }
    const text = `【艾莉丝提醒｜任务 ${completion.task.number}｜${title}｜本轮结束】\n${summary(payload['last-assistant-message']) || '本轮已结束，请回 Codex 查看结果。'}\n下一步可发：/${completion.task.number} 继续任务\n只有一个可续办任务时，也可发 /继续任务。`;
    return this.store.enqueue({ key: `completion:${session}:${key}`, session_id:session,peer: this.creds.peer, text });
  }
  event(data) {
    if (data.kind === 'notify') return this.notify(data.payload || {});
    if (data.event === 'SessionStart') { this.store.session(data.session_id, data.cwd || '', data.title || ''); this.store.audit('hook_session_start'); }
    if (['Interrupt', 'SessionEnd'].includes(data.event)) { for(const r of this.store.pending())if(r.session_id===data.session_id&&r.presentation!=='chat_text'&&(!data.turn_id||r.turn_id===data.turn_id))this.store.cancel(r.id);this.emit('changed'); }
    return { ok: true };
  }
  async close() {
    this.closed = true; this.abort.abort();
    for (let i = 0; i < 250 && this.sending; i++) await sleep(20);
    await this.vaultQueue.catch(() => {});
  }
}
