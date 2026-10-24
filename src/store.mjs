import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { randomId, summary } from './common.mjs';

export class Store {
  constructor(file, clock = Date.now) {
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS chat_modes (session_id TEXT PRIMARY KEY, mode TEXT NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, session_id TEXT, turn_id TEXT, title TEXT, questions TEXT, answers TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created INTEGER, expires INTEGER, lease INTEGER);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT, request_id TEXT, peer TEXT, text TEXT, state TEXT NOT NULL, created INTEGER, expires INTEGER, attempts INTEGER DEFAULT 0, error TEXT, sent INTEGER, client_id TEXT);
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY, received INTEGER);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (number INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE NOT NULL, title TEXT, cwd TEXT, state TEXT NOT NULL, last_turn TEXT, completed INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS task_number_history (epoch INTEGER,number INTEGER,session_id TEXT,title TEXT,cwd TEXT,state TEXT,last_turn TEXT,completed INTEGER,updated INTEGER,retired INTEGER,PRIMARY KEY(epoch,number));
      CREATE TABLE IF NOT EXISTS task_completions (session_id TEXT, turn_id TEXT, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS continuations (id TEXT PRIMARY KEY, inbound_id TEXT UNIQUE, task_number INTEGER, session_id TEXT, prompt TEXT, state TEXT, created INTEGER, updated INTEGER, worker_id TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time INTEGER, event TEXT, details TEXT);`);
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='local_available')) this.db.exec('ALTER TABLE requests ADD COLUMN local_available INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='question_epoch')) this.db.exec('ALTER TABLE requests ADD COLUMN question_epoch INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(c=>c.name==='presentation')) this.db.exec("ALTER TABLE requests ADD COLUMN presentation TEXT NOT NULL DEFAULT 'legacy'");
    if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(c=>c.name==='session_id')) this.db.exec("ALTER TABLE outbox ADD COLUMN session_id TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(continuations)').all().some(c=>c.name==='kind')) this.db.exec("ALTER TABLE continuations ADD COLUMN kind TEXT NOT NULL DEFAULT 'continuation'");
    if (!this.db.prepare('PRAGMA table_info(continuations)').all().some(c=>c.name==='question_number')) this.db.exec('ALTER TABLE continuations ADD COLUMN question_number INTEGER');
    if (!this.db.prepare('PRAGMA table_info(continuations)').all().some(c=>c.name==='task_epoch')) this.db.exec('ALTER TABLE continuations ADD COLUMN task_epoch INTEGER NOT NULL DEFAULT 0');
    // A process can die after send acceptance; do not blindly resend that record.
    this.db.prepare("UPDATE outbox SET state='uncertain', error='PROCESS_RESTART_DURING_SEND' WHERE state='sending'").run();
    this.db.prepare("UPDATE tasks SET state='uncertain' WHERE EXISTS (SELECT 1 FROM continuations c WHERE c.state='dispatching' AND c.task_number=tasks.number AND c.session_id=tasks.session_id AND c.task_epoch=?)").run(Number(this.meta('task_epoch')||0));
    this.db.prepare("UPDATE continuations SET state='uncertain',error='PROCESS_RESTART_DURING_DISPATCH',prompt='' WHERE state='dispatching'").run();
    // Question numbers remain stable across answers and service restarts, including concurrent chats.
    let counter = Number(this.meta('question_counter') || 0);
    const rows = this.db.prepare('SELECT id,status,questions FROM requests WHERE question_epoch=? ORDER BY created,rowid').all(Number(this.meta('question_epoch')||0));
    for (const row of rows) for (const q of JSON.parse(row.questions)) if (Number.isSafeInteger(q.number) && q.number > counter) counter = q.number;
    for (const row of rows) {
      if (row.status !== 'pending') continue;
      const questions = JSON.parse(row.questions); let changed = false;
      for (const q of questions) if (!Number.isSafeInteger(q.number) || q.number < 1) { q.number = ++counter; changed = true; }
      if (changed) this.db.prepare('UPDATE requests SET questions=? WHERE id=?').run(JSON.stringify(questions), row.id);
    }
    this.meta('question_counter', counter);
  }
  close() { this.db.close(); }
  meta(key, value) {
    if (value === undefined) return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value;
    this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  audit(event, details = {}) {
    this.db.prepare('INSERT INTO events(time,event,details) VALUES (?,?,?)').run(this.clock(), event, JSON.stringify(details));
  }
  session(id, cwd = '', title = '') {
    if (!id) return;
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=CASE WHEN excluded.cwd=\'\' THEN sessions.cwd ELSE excluded.cwd END,title=CASE WHEN excluded.title=\'\' THEN sessions.title ELSE excluded.title END,updated=excluded.updated').run(id, cwd, title, this.clock());
  }
  sessionTitle(id) { return this.db.prepare('SELECT title,cwd FROM sessions WHERE id=?').get(id); }
  chatMode(session) { return this.db.prepare('SELECT mode FROM chat_modes WHERE session_id=?').get(session)?.mode || 'native'; }
  setChatMode(session,mode) {
    if(!session||!['native','wechat'].includes(mode))throw new Error('Invalid chat mode');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO chat_modes VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode,updated=excluded.updated').run(session,mode,this.clock());
      if(mode==='native'){
        this.cancelSession(session);
        this.db.prepare("UPDATE outbox SET state='cancelled' WHERE session_id=? AND state IN ('queued','deferred')").run(session);
        this.db.prepare("UPDATE continuations SET state='cancelled',prompt='',error='CHAT_MODE_DISABLED' WHERE session_id=? AND state='queued' AND kind='question_answer'").run(session);
      }
      this.db.exec('COMMIT');return {session_id:session,mode};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY number').all(); }
  task(number) { return this.db.prepare('SELECT * FROM tasks WHERE number=?').get(number); }
  taskForSession(session) { return this.db.prepare('SELECT * FROM tasks WHERE session_id=?').get(session); }
  completeTask(session, turn, title, cwd = '', {allocate=true} = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO task_completions VALUES (?,?)').run(session, turn).changes;
      if (added) {
        if(this.taskForSession(session))this.db.prepare("UPDATE tasks SET title=?,cwd=?,state='completed',last_turn=?,completed=?,updated=? WHERE session_id=?").run(title,cwd,turn,this.clock(),this.clock(),session);
        else if(allocate)this.db.prepare("INSERT INTO tasks(session_id,title,cwd,state,last_turn,completed,updated) VALUES (?,?,?,'completed',?,?,?)").run(session,title,cwd,turn,this.clock(),this.clock());
      }
      const task = this.db.prepare('SELECT * FROM tasks WHERE session_id=?').get(session);
      this.db.exec('COMMIT'); return { task, duplicate: !added };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  enqueueContinuation(task, prompt, inbound) {
    const id = randomId(), at = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE tasks SET state='queued',updated=? WHERE number=? AND session_id=? AND state='completed'").run(at, task.number,task.session_id).changes;
      if (!changed) { this.db.exec('COMMIT'); return null; }
      this.db.prepare("INSERT INTO continuations(id,inbound_id,task_number,session_id,prompt,state,created,updated) VALUES (?,?,?,?,?,'queued',?,?)").run(id, inbound, task.number, task.session_id, prompt, at, at);
      this.db.prepare('UPDATE continuations SET task_epoch=? WHERE id=?').run(Number(this.meta('task_epoch')||0),id);
      this.db.exec('COMMIT'); return this.continuation(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  continuation(id) { return this.db.prepare('SELECT * FROM continuations WHERE id=?').get(id); }
  questionByNumber(number) {
    if (!Number.isSafeInteger(number) || number<1) return null;
    for (const row of this.db.prepare('SELECT id FROM requests WHERE question_epoch=? ORDER BY created DESC').all(Number(this.meta('question_epoch')||0))) {
      const request=this.request(row.id),question=request.questions.find(q=>q.number===number);
      if (question) return {request,question};
    }
    return null;
  }
  enqueueQuestionSupplement(request,question,prompt,inbound) {
    const id=randomId(),at=this.clock();
    const result=this.db.prepare("INSERT OR IGNORE INTO continuations(id,inbound_id,task_number,session_id,prompt,state,created,updated,question_number) VALUES (?,?,NULL,?,?,'queued',?,?,?)")
      .run(id,inbound,request.session_id,`【第${question.number}题的后续补充】\n${prompt}`,at,at,question.number);
    if (!result.changes) return null;
    this.db.prepare('UPDATE continuations SET task_epoch=? WHERE id=?').run(Number(this.meta('task_epoch')||0),id);
    this.audit('question_supplement_queued',{number:question.number});return this.continuation(id);
  }
  claimContinuation(worker) {
    const row = this.db.prepare("SELECT * FROM continuations WHERE state='queued' ORDER BY created LIMIT 1").get();
    if (!row) return null;
    const changed = this.db.prepare("UPDATE continuations SET state='dispatching',worker_id=?,updated=? WHERE id=? AND state='queued'").run(worker, this.clock(), row.id).changes;
    return changed ? this.continuation(row.id) : null;
  }
  finishContinuation(id, worker, state, error = '') {
    if (!['delivered', 'failed', 'uncertain', 'expired'].includes(state)) throw new Error('Invalid continuation result');
    const row = this.continuation(id);
    if (!row || row.state !== 'dispatching' || row.worker_id !== worker) return null;
    this.db.prepare('UPDATE continuations SET state=?,error=?,prompt=\'\',updated=? WHERE id=?').run(state, error.slice(0, 64), this.clock(), id);
    // A later completion may already have arrived; do not overwrite its state.
    if(row.task_epoch===Number(this.meta('task_epoch')||0))this.db.prepare("UPDATE tasks SET state=?,updated=? WHERE number=? AND session_id=? AND state='queued'").run(state === 'delivered' ? 'active' : state === 'uncertain' ? 'uncertain' : 'completed', this.clock(), row.task_number,row.session_id);
    this.audit('continuation_result', { task: row.task_number, state, error: error.slice(0, 64) });
    return row;
  }
  staleContinuations() {
    const stale = this.db.prepare("SELECT * FROM continuations WHERE (state='queued' AND created<? AND kind<>'question_answer') OR (state='queued' AND created<? AND kind='question_answer') OR (state='dispatching' AND updated<?)").all(this.clock() - 120000, this.clock() - 86400000, this.clock() - 90000);
    for (const row of stale) {
      if (row.state === 'queued') this.db.prepare("UPDATE continuations SET state='dispatching',worker_id='expired' WHERE id=?").run(row.id);
      this.finishContinuation(row.id, row.worker_id || 'expired', row.state === 'queued' ? 'expired' : 'uncertain', 'DISPATCH_TIMEOUT');
    }
    return stale;
  }
  request(id) {
    const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    return row && { ...row, questions: JSON.parse(row.questions), answers: JSON.parse(row.answers) };
  }
  byKey(key) { const row = this.db.prepare('SELECT id FROM requests WHERE request_key=?').get(key); return row && this.request(row.id); }
  pending() { this.sweep(); return this.db.prepare("SELECT id FROM requests WHERE status='pending' ORDER BY created").all().map(r => this.request(r.id)); }
  createRequest({ request_key, session_id, turn_id = '', title = '', questions, ttl_ms = 86400000, local_available = false, presentation = 'legacy' }) {
    const existing = this.byKey(request_key); if (existing) return existing;
    if (!Array.isArray(questions) || !questions.length || questions.length > 3) throw new Error('需要 1–3 道问题');
    const ids = new Set();
    const normalized = questions.map((q, i) => {
      const id = String(q.id || `question_${i + 1}`);
      if (!/^[\w-]{1,80}$/.test(id) || ids.has(id)) throw new Error('问题 ID 无效或重复');
      ids.add(id);
      const question = String(q.question || q.prompt || '').trim();
      if (!question || question.length > 1500) throw new Error('问题长度应在 1–1500 字符');
      const options = (q.options || []).map(o => typeof o === 'string' ? { label: o, description: '' } : { label: String(o.label || ''), description: String(o.description || '') });
      if (options.length > 8 || options.some(o => !o.label || o.label.length > 180 || o.description.length > 250)) throw new Error('选项无效');
      return { id, question, options, code: `Q${crypto.randomBytes(4).toString('hex').toUpperCase()}` };
    });
    let counter = Number(this.meta('question_counter') || 0);
    for (const q of normalized) q.number = ++counter;
    this.meta('question_counter', counter);
    const id = randomId(), at = this.clock();
    this.db.prepare('INSERT INTO requests(id,request_key,session_id,turn_id,title,questions,status,created,expires,lease) VALUES (?,?,?,?,?,?,\'pending\',?,?,?)')
      .run(id, request_key, session_id, turn_id, summary(title, 40), JSON.stringify(normalized), at, at + Math.min(Math.max(ttl_ms, 60000), 86400000), at + 90000);
    this.db.prepare('UPDATE requests SET local_available=?,question_epoch=? WHERE id=?').run(local_available ? 1 : 0,Number(this.meta('question_epoch')||0),id);
    this.db.prepare('UPDATE requests SET presentation=? WHERE id=?').run(presentation,id);
    this.audit('question_created', { id, count: normalized.length });
    return this.request(id);
  }
  renew(id) { this.db.prepare("UPDATE requests SET lease=? WHERE id=? AND status='pending'").run(this.clock() + 90000, id); }
  cancel(id, reason = 'cancelled') {
    this.db.prepare("UPDATE requests SET status=? WHERE id=? AND status='pending'").run(reason, id);
    this.db.prepare("UPDATE outbox SET state='cancelled' WHERE request_id=? AND state IN ('queued','deferred')").run(id);
  }
  cancelSession(session, turn = '') {
    for (const r of this.pending()) if (r.session_id === session && (!turn || r.turn_id === turn)) this.cancel(r.id);
  }
  clearQuestions() {
    this.sweep();this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows=this.db.prepare("SELECT id,questions,answers FROM requests WHERE status='pending'").all();
      const count=rows.reduce((n,r)=>n+JSON.parse(r.questions).filter(q=>!JSON.parse(r.answers)[q.id]).length,0);
      for(const r of rows)this.cancel(r.id);
      const at=this.clock(),epoch=Number(this.meta('question_epoch')||0)+1,taskEpoch=Number(this.meta('task_epoch')||0);
      this.meta('question_epoch',epoch);this.meta('question_counter',0);this.meta('question_reset_at',at);
      const supplements=this.db.prepare("SELECT count(*) AS n FROM continuations WHERE question_number IS NOT NULL AND state='queued'").get().n;
      const continuations=this.db.prepare("UPDATE continuations SET state='cancelled',prompt='',error='NUMBERS_CLEARED',updated=? WHERE state='queued'").run(at).changes;
      const retired=this.db.prepare('INSERT INTO task_number_history SELECT ?,number,session_id,title,cwd,state,last_turn,completed,updated,? FROM tasks').run(taskEpoch,at).changes;
      this.db.exec("DELETE FROM tasks; DELETE FROM sqlite_sequence WHERE name='tasks'");
      this.meta('task_epoch',taskEpoch+1);this.meta('task_reset_at',at);
      if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dot_requests'").get())this.db.exec('UPDATE dot_requests SET task_number=NULL');
      this.db.prepare("UPDATE outbox SET state='cancelled' WHERE state IN ('queued','deferred') AND (kind='completion' OR (kind='receipt' AND (event_key LIKE 'dot-bound:%' OR event_key LIKE 'continuation-result:%')))").run();
      this.audit('questions_cleared',{pending_questions:count,queued_supplements_cancelled:supplements,queued_continuations_cancelled:continuations,retired_tasks:retired,epoch,task_epoch:taskEpoch+1});
      this.db.exec('COMMIT');return {pending_questions:count,queued_supplements_cancelled:supplements,queued_continuations_cancelled:continuations,retired_tasks:retired,next_question_number:1,next_task_number:1};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  sweep() {
    const at = this.clock();
    const stale = this.db.prepare("SELECT id FROM requests WHERE status='pending' AND (expires<=? OR (presentation<>'chat_text' AND lease<=?))").all(at, at);
    for (const r of stale) this.cancel(r.id, 'expired');
    this.db.prepare("UPDATE outbox SET state='expired' WHERE state IN ('queued','deferred') AND expires<=?").run(at);
  }
  acceptInbound(id) { return this.db.prepare('INSERT OR IGNORE INTO inbound VALUES (?,?)').run(id, this.clock()).changes === 1; }
  answer(requestId, q, text, messageId, source = 'wechat') {
    this.sweep();
    if (!['wechat','local','codex'].includes(source)) throw new Error('Invalid answer source');
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const r = this.request(requestId);
    if (!r || r.status !== 'pending' || !r.questions.some(x=>x.id===q.id) || r.answers[q.id]) {this.db.exec('COMMIT');return false;}
    r.answers[q.id] = { answers: [text], source, message_id: messageId, received_at: this.clock() };
    const done = r.questions.every(x => r.answers[x.id]);
    this.db.prepare('UPDATE requests SET answers=?,status=? WHERE id=? AND status=\'pending\'').run(JSON.stringify(r.answers), done ? 'answered' : 'pending', r.id);
    this.db.prepare("UPDATE outbox SET state='cancelled' WHERE event_key=? AND state IN ('queued','deferred')").run(`question:${r.id}:${q.id}`);
    if(source==='wechat'&&r.presentation==='chat_text'){
      this.db.prepare("INSERT OR IGNORE INTO continuations(id,inbound_id,task_number,session_id,prompt,state,created,updated,question_number,task_epoch,kind) VALUES (?,?,NULL,?,?,'queued',?,?,?,?,'question_answer')")
        .run(randomId(),`answer:${r.id}:${q.id}`,r.session_id,`【本人微信回答｜第${q.number}题】\n问题：${q.question}\n答案：${text}\n此为该普通问题的真实回答，不能作为执行权限审批。请求 ID：${r.id}`,this.clock(),this.clock(),q.number,Number(this.meta('task_epoch')||0));
    }
    this.audit('question_answered', { id: r.id, question_id: q.id, complete: done,source });
    this.db.exec('COMMIT');
    return true;
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  enqueue({ key, kind = 'completion', request_id = '', peer, text, ttl_ms = 86400000, session_id = '' }) {
    const id = randomId(), at = this.clock();
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,event_key,kind,request_id,peer,text,state,created,expires,client_id) VALUES (?,?,?,?,?,?,\'queued\',?,?,?)')
      .run(id, key, kind, request_id, peer, text, at, at + ttl_ms, `codex-wechat-${id}`);
    if(session_id)this.db.prepare('UPDATE outbox SET session_id=? WHERE id=?').run(session_id,id);
    return this.db.prepare('SELECT id,state FROM outbox WHERE event_key=?').get(key);
  }
  next(peer) {
    this.sweep();
    return this.db.prepare("SELECT * FROM outbox WHERE peer=? AND state='queued' ORDER BY CASE kind WHEN 'question' THEN 0 WHEN 'receipt' THEN 1 ELSE 2 END, created LIMIT 1").get(peer);
  }
  sent(id) { this.db.prepare("UPDATE outbox SET state='sent',sent=?,text='',error=NULL WHERE id=?").run(this.clock(), id); }
  sending(id) { this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='queued'").run(id); }
  failed(id, state, code) { this.db.prepare('UPDATE outbox SET state=?,error=? WHERE id=?').run(state, code, id); }
  reactivate(peer) { this.db.prepare("UPDATE outbox SET state='queued',error=NULL WHERE peer=? AND state='deferred'").run(peer); }
  retryRateLimited(peer) {
    this.sweep();
    this.db.prepare("UPDATE outbox SET state='queued' WHERE peer=? AND state='deferred' AND error='HTTP_429' AND attempts<3 AND expires>? AND (kind<>'question' OR EXISTS (SELECT 1 FROM requests WHERE requests.id=outbox.request_id AND requests.status='pending'))").run(peer,this.clock());
  }
  stats() {
    this.sweep();
    return { outbox: this.db.prepare('SELECT state,count(*) AS count FROM outbox GROUP BY state').all(), last_sent: this.db.prepare('SELECT max(sent) AS time FROM outbox').get().time,
      recent_events: this.db.prepare('SELECT time,event,details FROM events ORDER BY id DESC LIMIT 12').all() };
  }
  prune() {
    const old = this.clock() - 7 * 86400000;
    this.db.prepare('DELETE FROM inbound WHERE received<?').run(old);
    this.db.prepare('DELETE FROM outbox WHERE created<? AND state NOT IN (\'queued\',\'deferred\',\'sending\')').run(old);
    this.db.prepare("DELETE FROM requests WHERE created<? AND status<>'pending'").run(old);
    this.db.prepare('DELETE FROM events WHERE time<?').run(old);
    this.db.prepare("DELETE FROM continuations WHERE updated<? AND state NOT IN ('queued','dispatching')").run(old);
  }
}

export function questionMessage(request, q) {
  return `【艾莉丝提醒｜${request.title || 'Codex 等待回答'}】\n第${q.number}题：${q.question}\n` + q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
    + `\n微信或电脑均可回答，先收到的有效答案生效。单题直接回数字或文字；多题回「${q.number}.1」或「${q.number}.你的文字」。答完仍可发「${q.number}.补充内容」。`;
}

export function questionMarkdown(request) {
  return request.questions.filter(q=>!request.answers[q.id]).map(q=>[
    `> **待你回答｜第${q.number}题${request.title?' · '+request.title:''}**`,
    ...q.question.split('\n').map(line=>`> ${line}`),'>',
    ...q.options.map((o,i)=>`> ${i+1}. ${o.label}${o.description?' — '+o.description:''}`),'>',
    `> 可直接在此聊天或微信回复；多题请用「${q.number}.选项或文字」。`
  ].join('\n')).join('\n\n');
}

export function resolveReply(pending, raw, createdAt = Date.now()) {
  let text = String(raw).trim();
  const available = pending.flatMap(r => r.questions.filter(q => !r.answers[q.id]).map(q => ({ r, q })));
  if (/^[（(]\s*\d+\s*[.．。][\s\S]+[）)]$/.test(text)) text = text.slice(1, -1).trim();
  const match = /^(Q[0-9A-F]{8})\s*[:：、,，]?\s+([\s\S]+)$/i.exec(text);
  const numbered = /^(\d+)\s*[.．。]\s*([\s\S]+)$/.exec(text);
  let target;
  if (match) { target = available.find(x => x.q.code === match[1].toUpperCase()); text = match[2].trim(); }
  else if (numbered) { target = available.find(x => x.q.number === Number(numbered[1])); text = numbered[2].trim(); }
  else if (available.length === 1 && !/^Q[0-9A-F]{8}\b/i.test(text)) target = available[0];
  if (!target) return { ok: false, reason: !available.length ? '当前没有待答问题。已提交的答案无需重复回复。' : numbered || match ? '这道题已回答、已失效或题号不存在。发送「待答」查看当前题号。' : `同时有多道问题，请回复「题号.选项」或「题号.你的文字」，例如 ${available[0].q.number}.1。发送「待答」查看。` };
  if (createdAt < target.r.created - (target.r.question_epoch>0?0:5000)) return { ok: false, reason: '这条消息早于问题，未作为答案。请重新回复。' };
  const custom = /^自定义\s*[:：]\s*([\s\S]+)$/i.exec(text);
  if (custom) text = custom[1].trim();
  else if (/^\d+$/.test(text) && target.q.options.length) {
    const index = Number(text) - 1;
    if (index < 0 || index >= target.q.options.length) return { ok: false, reason: `${target.q.code} 的选项编号无效。数字答案请使用「自定义：」。` };
    text = target.q.options[index].label;
  }
  if (!text || text.length > 8000) return { ok: false, reason: '答案不能为空，且不能超过 8000 字符。' };
  return { ok: true, request: target.r, question: target.q, answer: text };
}
