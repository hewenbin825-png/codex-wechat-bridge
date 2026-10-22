import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { randomId, summary } from './common.mjs';

export class Store {
  constructor(file, clock = Date.now) {
    this.clock = clock;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated INTEGER);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, session_id TEXT, turn_id TEXT, title TEXT, questions TEXT, answers TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created INTEGER, expires INTEGER, lease INTEGER);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, event_key TEXT UNIQUE, kind TEXT, request_id TEXT, peer TEXT, text TEXT, state TEXT NOT NULL, created INTEGER, expires INTEGER, attempts INTEGER DEFAULT 0, error TEXT, sent INTEGER, client_id TEXT);
      CREATE TABLE IF NOT EXISTS inbound (id TEXT PRIMARY KEY, received INTEGER);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS tasks (number INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE NOT NULL, title TEXT, cwd TEXT, state TEXT NOT NULL, last_turn TEXT, completed INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS task_completions (session_id TEXT, turn_id TEXT, PRIMARY KEY(session_id,turn_id));
      CREATE TABLE IF NOT EXISTS continuations (id TEXT PRIMARY KEY, inbound_id TEXT UNIQUE, task_number INTEGER, session_id TEXT, prompt TEXT, state TEXT, created INTEGER, updated INTEGER, worker_id TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, time INTEGER, event TEXT, details TEXT);`);
    // A process can die after send acceptance; do not blindly resend that record.
    this.db.prepare("UPDATE outbox SET state='uncertain', error='PROCESS_RESTART_DURING_SEND' WHERE state='sending'").run();
    this.db.prepare("UPDATE tasks SET state='uncertain' WHERE number IN (SELECT task_number FROM continuations WHERE state='dispatching')").run();
    this.db.prepare("UPDATE continuations SET state='uncertain',error='PROCESS_RESTART_DURING_DISPATCH',prompt='' WHERE state='dispatching'").run();
    // Question numbers remain stable across answers and service restarts, including concurrent chats.
    let counter = Number(this.meta('question_counter') || 0);
    const rows = this.db.prepare('SELECT id,status,questions FROM requests ORDER BY created,rowid').all();
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
  tasks() { return this.db.prepare('SELECT * FROM tasks ORDER BY number').all(); }
  task(number) { return this.db.prepare('SELECT * FROM tasks WHERE number=?').get(number); }
  completeTask(session, turn, title, cwd = '') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const added = this.db.prepare('INSERT OR IGNORE INTO task_completions VALUES (?,?)').run(session, turn).changes;
      if (added) this.db.prepare("INSERT INTO tasks(session_id,title,cwd,state,last_turn,completed,updated) VALUES (?,?,?,'completed',?,?,?) ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,cwd=excluded.cwd,state='completed',last_turn=excluded.last_turn,completed=excluded.completed,updated=excluded.updated")
        .run(session, title, cwd, turn, this.clock(), this.clock());
      const task = this.db.prepare('SELECT * FROM tasks WHERE session_id=?').get(session);
      this.db.exec('COMMIT'); return { task, duplicate: !added };
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  enqueueContinuation(task, prompt, inbound) {
    const id = randomId(), at = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db.prepare("UPDATE tasks SET state='queued',updated=? WHERE number=? AND state='completed'").run(at, task.number).changes;
      if (!changed) { this.db.exec('COMMIT'); return null; }
      this.db.prepare("INSERT INTO continuations(id,inbound_id,task_number,session_id,prompt,state,created,updated) VALUES (?,?,?,?,?,'queued',?,?)").run(id, inbound, task.number, task.session_id, prompt, at, at);
      this.db.exec('COMMIT'); return this.continuation(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  continuation(id) { return this.db.prepare('SELECT * FROM continuations WHERE id=?').get(id); }
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
    this.db.prepare("UPDATE tasks SET state=?,updated=? WHERE number=? AND state='queued'").run(state === 'delivered' ? 'active' : state === 'uncertain' ? 'uncertain' : 'completed', this.clock(), row.task_number);
    this.audit('continuation_result', { task: row.task_number, state, error: error.slice(0, 64) });
    return row;
  }
  staleContinuations() {
    const stale = this.db.prepare("SELECT * FROM continuations WHERE (state='queued' AND created<?) OR (state='dispatching' AND updated<?)").all(this.clock() - 120000, this.clock() - 90000);
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
  createRequest({ request_key, session_id, turn_id = '', title = '', questions, ttl_ms = 86400000 }) {
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
  sweep() {
    const at = this.clock();
    const stale = this.db.prepare("SELECT id FROM requests WHERE status='pending' AND (expires<=? OR lease<=?)").all(at, at);
    for (const r of stale) this.cancel(r.id, 'expired');
    this.db.prepare("UPDATE outbox SET state='expired' WHERE state IN ('queued','deferred') AND expires<=?").run(at);
  }
  acceptInbound(id) { return this.db.prepare('INSERT OR IGNORE INTO inbound VALUES (?,?)').run(id, this.clock()).changes === 1; }
  answer(requestId, q, text, messageId) {
    const r = this.request(requestId);
    if (!r || r.status !== 'pending' || r.answers[q.id]) return false;
    r.answers[q.id] = { answers: [text], source: 'wechat', message_id: messageId, received_at: this.clock() };
    const done = r.questions.every(x => r.answers[x.id]);
    this.db.prepare('UPDATE requests SET answers=?,status=? WHERE id=? AND status=\'pending\'').run(JSON.stringify(r.answers), done ? 'answered' : 'pending', r.id);
    this.audit('question_answered', { id: r.id, question_id: q.id, complete: done });
    return true;
  }
  enqueue({ key, kind = 'completion', request_id = '', peer, text, ttl_ms = 86400000 }) {
    const id = randomId(), at = this.clock();
    this.db.prepare('INSERT OR IGNORE INTO outbox(id,event_key,kind,request_id,peer,text,state,created,expires,client_id) VALUES (?,?,?,?,?,?,\'queued\',?,?,?)')
      .run(id, key, kind, request_id, peer, text, at, at + ttl_ms, `codex-wechat-${id}`);
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
  return `【${request.title || 'Codex 等待回答'}】\n第${q.number}题：${q.question}\n` + q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
    + `\n单题直接回数字或文字；多题回「${q.number}.1」或「${q.number}.你的文字」。`;
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
  if (createdAt < target.r.created - 5000) return { ok: false, reason: '这条消息早于问题，未作为答案。请重新回复。' };
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
