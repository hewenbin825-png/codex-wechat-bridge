import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import http from 'node:http';
import { Store, resolveReply } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { WeChatApi, parseWireJson, trustedBase } from '../src/wechat.mjs';
import { WindowsVault, summary, ROOT, sleep } from '../src/common.mjs';
import { handleHook } from '../src/hook.mjs';
import { serve } from '../src/service.mjs';

function fixture(t, clock = Date.now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wechat-test-'));
  const store = new Store(path.join(dir, 'test.sqlite'), clock);
  const api = { sent: [], async send(c, text, id) { this.sent.push({ peer: c.peer, text, id }); }, async startLogin() { return { qrcode: 'q', qrcode_img_content: 'https://weixin.qq.com/q/test' }; } };
  const vault = { value: null, async load() { return this.value; }, async save(value) { this.value = structuredClone(value); } };
  const bridge = new Bridge({ store, api, vault, clock, sessionLookup: id => ({id,root:true,title:id,archived:0}) });
  bridge.creds = { token: 'fake-token-not-a-real-credential', peer: 'owner@im.wechat', base: 'https://ilinkai.weixin.qq.com', contextToken: 'fake-context' };
  t.after(async () => { await bridge.close(); store.close(); });
  const ask = (session = 'session-A', key = session, questions = [{ id: 'choice', question: '下一步？', options: [{ label: '继续' }, { label: '暂停' }] }]) => bridge.ask({ request_key: key, session_id: session, turn_id: 'turn-1', title: session, questions });
  const incoming = (text, id = '1', overrides = {}) => ({ from_user_id: 'owner@im.wechat', message_type: 1, message_id: id, context_token: 'fresh-context', create_time_ms: clock(), item_list: [{ type: 1, text_item: { text } }], ...overrides });
  return { dir, store, api, vault, bridge, ask, incoming };
}

test('choice and custom answers return only to the correct pending question; duplicates are ignored', async t => {
  const f = fixture(t); const a = f.ask(); const b = f.ask('session-B');
  await f.bridge.receive(f.incoming('1', 'ambiguous'));
  assert.equal(f.store.request(a.id).status, 'pending'); assert.equal(f.store.request(b.id).status, 'pending');
  await f.bridge.receive(f.incoming(`${a.questions[0].code} 2`, 'answer-A'));
  assert.deepEqual(f.store.request(a.id).answers.choice.answers, ['暂停']);
  assert.equal(f.store.request(b.id).status, 'pending');
  assert.deepEqual(await f.bridge.receive(f.incoming('1', 'answer-A')), { duplicate: true });
  await f.bridge.receive(f.incoming('自定义：保留现场，先整理原因', 'answer-B'));
  assert.deepEqual(f.store.request(b.id).answers.choice.answers, ['保留现场，先整理原因']);
});

test('unbound senders, stale messages, invalid options, cancellation and expiration cannot answer', async t => {
  let at = 1000000; const f = fixture(t, () => at); const r = f.ask();
  await f.bridge.receive(f.incoming('1', 'other-user', { from_user_id: 'intruder' }));
  await f.bridge.receive(f.incoming('1', 'stale', { create_time_ms: 1 }));
  await f.bridge.receive(f.incoming('9', 'invalid'));
  assert.equal(f.store.request(r.id).status, 'pending');
  f.store.cancel(r.id); await f.bridge.receive(f.incoming(`${r.questions[0].code} 1`, 'late'));
  assert.equal(f.store.request(r.id).status, 'cancelled');
  const second = f.ask('other'); at += 91000; f.store.sweep();
  assert.equal(f.store.request(second.id).status, 'expired');
  assert.equal(resolveReply(f.store.pending(), '1', at).ok, false);
});

test('multi-question groups require all answers and request retries do not resend questions', async t => {
  const f = fixture(t); const qs = [{ id: 'a', question: '格式？', options: ['Word', 'PDF'] }, { id: 'b', question: '标题？' }];
  const r = f.ask('A', 'stable-key', qs); assert.equal(f.ask('A', 'stable-key', qs).id, r.id);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='question'").get().n, 2);
  await f.bridge.receive(f.incoming(`${r.questions[1].code} 自定义：汇总报告`, 'one'));
  assert.equal(f.store.request(r.id).status, 'pending');
  await f.bridge.receive(f.incoming(`${r.questions[0].code} 1`, 'two'));
  assert.equal(f.store.request(r.id).status, 'answered');
});

test('completion deduplication, pending suppression and redacted summaries', async t => {
  const f = fixture(t);
  const p = { type: 'agent-turn-complete', 'thread-id': 'A', 'turn-id': 'T', 'last-assistant-message': '处理完成。Bearer secret-value sk-abcdefghijklmnopqrstuvwxyz' };
  f.bridge.notify(p); f.bridge.notify(p);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n, 1);
  await f.bridge.drainOnce(); assert.equal(f.api.sent.length, 1); assert.ok(!f.api.sent[0].text.includes('secret-value'));
  f.ask('B'); assert.equal(f.bridge.notify({ ...p, 'thread-id': 'B', 'turn-id': 'turn-1' }).suppressed, 'waiting_for_answer');
  assert.equal(summary('```password=abc```\n完成'), '[代码略] 完成');
});

test('uncertain sends are never automatically resent; platform rejection waits for activation', async t => {
  const f = fixture(t);
  f.api.send = async () => { throw Object.assign(new Error('timeout'), { uncertain: true, code: 'NETWORK_TIMEOUT' }); };
  const n = f.store.enqueue({ key: 'uncertain', peer: f.bridge.creds.peer, text: '通知' });
  await f.bridge.drainOnce(); await f.bridge.drainOnce();
  assert.equal(f.store.db.prepare('SELECT state,attempts FROM outbox WHERE id=?').get(n.id).state, 'uncertain');
  assert.equal(f.store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(n.id).attempts, 1);
  f.bridge.blockedUntil = 0;
  f.api.send = async () => { throw Object.assign(new Error('quota'), { deferred: true, code: 'HTTP_429' }); };
  const d = f.store.enqueue({ key: 'quota', peer: f.bridge.creds.peer, text: '通知' }); await f.bridge.drainOnce();
  assert.equal(f.bridge.ready(), false); assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(d.id).state, 'deferred');
  await f.bridge.receive(f.incoming('激活', 'reactivate'));
  assert.equal(f.bridge.ready(), true); assert.equal(f.store.db.prepare('SELECT state FROM outbox WHERE id=?').get(d.id).state, 'queued');
});

test('undeliverable questions return unavailable instead of waiting without delivery', async t => {
  const f = fixture(t); const r = f.ask();
  f.api.send = async () => { throw Object.assign(new Error('quota'), { deferred: true, code: 'HTTP_429' }); };
  await f.bridge.drainOnce();
  assert.equal(f.store.request(r.id).status, 'unavailable'); assert.equal(f.bridge.ready(), false);
});

test('Tencent request construction, exact uint64 IDs and trusted redirects', async () => {
  const requests = []; const api = new WeChatApi({ fetchImpl: async (url, init) => { requests.push({ url, ...init }); return new Response('{"ret":0,"message_id":18446744073709551615}'); } });
  await api.startLogin(); assert.equal(requests[0].headers.Authorization, undefined);
  assert.ok(requests[0].url.endsWith('get_bot_qrcode?bot_type=3'));
  const parsed = await api.send({ token: 'test', peer: 'owner', contextToken: 'context', base: 'https://ilinkai.weixin.qq.com' }, '测试', 'stable');
  assert.equal(parsed.message_id, '18446744073709551615');
  assert.equal(JSON.parse(requests[1].body).msg.context_token, 'context');
  assert.equal(requests[1].headers.Authorization, 'Bearer test');
  assert.throws(() => trustedBase('https://weixin.qq.com.evil.test/'));
  assert.throws(() => trustedBase('http://ilinkai.weixin.qq.com'));
  const raw = JSON.stringify({ text: '"message_id":18446744073709551615' }); assert.equal(parseWireJson(raw).text, '"message_id":18446744073709551615');
});

test('hooks preserve native fallback, inject real context and never approve permissions', async () => {
  const native = { hook_event_name: 'PreToolUse', tool_name: 'request_user_input', session_id: 'actual', turn_id: 'T' };
  assert.deepEqual(await handleHook(native, { api: async () => ({ ready: true }) }), {});
  assert.deepEqual(await handleHook(native, { api: async () => { throw new Error('offline'); } }), {});
  assert.deepEqual(await handleHook({ ...native, tool_name: 'request_permissions' }, { api: async () => ({ ready: true }) }), {});
  const changed = await handleHook({ ...native, tool_name: 'mcp__wechat_bridge__ask_user', tool_use_id: 'tool-7', tool_input: { session_id: 'forged', questions: [] } });
  assert.equal(changed.hookSpecificOutput.updatedInput.session_id, 'actual');
  assert.equal(changed.hookSpecificOutput.updatedInput.request_key, 'actual:T:tool-7');
});

test('Windows DPAPI stores ciphertext and recovers only through the local account', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wechat-vault-')); const vault = new WindowsVault(dir);
  const value = { token: 'DUMMY-NON-SECRET-ROUNDTRIP', peer: 'test', text: '中文加密往返' };
  await vault.save(value); assert.ok(!fs.readFileSync(vault.file, 'utf8').includes(value.token)); assert.deepEqual(await vault.load(), value);
});

test('local HTTP rejects anonymous, cross-origin and rebound-host requests', async t => {
  const f = fixture(t); const app = await serve({ state: f.dir, port: 0, bridge: f.bridge, listen: false });
  t.after(async () => { await app.close(); });
  // app.close owns store; avoid a second close in the fixture cleanup.
  const close = f.store.close.bind(f.store); let closed = false; f.store.close = () => { if (!closed) { closed = true; close(); } };
  const base = `http://127.0.0.1:${app.port}`;
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const token = fs.readFileSync(path.join(f.dir, 'control.token'), 'utf8');
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/api/status`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/status`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.request(`${base}/api/status`, { headers: { ...headers, Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(reboundStatus, 403);
});

test('real MCP child waits, accepts a WeChat answer and returns to the same tool call', async t => {
  const f = fixture(t); const app = await serve({ state: f.dir, port: 0, bridge: f.bridge, listen: false });
  const close = f.store.close.bind(f.store); let closed = false; f.store.close = () => { if (!closed) { closed = true; close(); } };
  t.after(async () => { await app.close(); });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp.mjs')], { env: { ...process.env, CODEX_WECHAT_STATE: f.dir, CODEX_THREAD_ID: 'original-chat' }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume(); const replies = new Map(); const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', text => { const msg = JSON.parse(text); replies.set(msg.id, msg); waiting.get(msg.id)?.(msg); });
  const rpc = (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('MCP test timed out')), 10000); waiting.set(id, msg => { clearTimeout(timer); resolve(msg); }); }); };
  t.after(() => { child.stdin.end(); child.kill(); });
  assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name, 'codex-wechat-bridge');
  assert.ok((await rpc(2, 'tools/list', {})).result.tools.some(x => x.name === 'ask_user'));
  const pendingResult = rpc(3, 'tools/call', { name: 'ask_user', arguments: { title: '实际工具往返', questions: [{ id: 'choice', question: '选一个', options: [{ label: '继续' }, { label: '暂停' }] }] } });
  let group;
  for (let i = 0; i < 50 && !group; i++) { group = f.store.pending()[0]; if (!group) await sleep(50); }
  assert.equal(group.session_id, 'original-chat'); assert.equal(replies.has(3), false);
  await f.bridge.receive(f.incoming('自定义：只整理结果', 'mcp-answer'));
  const reply = await pendingResult;
  assert.equal(reply.id, 3); assert.equal(reply.result.structuredContent.status, 'answered');
  assert.deepEqual(reply.result.structuredContent.answers.choice.answers, ['只整理结果']);
});

test('installation and uninstall preserve existing notify, permissions, hooks and later user edits', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wechat-install-'));
  const original = 'model = "keep-model"\nsandbox_mode = "workspace-write"\nnotify = ["original.exe", "turn-ended", "--previous-notify", "[\\"eris.exe\\"]"]\n[mcp_servers.keep]\ncommand="keep.exe"\n';
  fs.writeFileSync(path.join(dir, 'config.toml'), original); fs.writeFileSync(path.join(dir, 'AGENTS.md'), '保留浏览器偏好\n');
  fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-safe-hook' }] }] } }));
  const script = path.join(ROOT, 'scripts', 'manage.py');
  const run = action => spawnSync('python', [script, action, '--codex-home', dir, '--node', process.execPath], { encoding: 'utf8', windowsHide: true });
  const installed = run('install'); assert.equal(installed.status, 0, installed.stderr);
  let config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'); assert.ok(config.includes('original.exe')); assert.ok(config.includes('workspace-write'));
  assert.ok(fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8').includes('existing-safe-hook'));
  fs.writeFileSync(path.join(dir, 'config.toml'), config.replace('keep-model', 'user-new-model'));
  const removed = run('uninstall'); assert.equal(removed.status, 0, removed.stderr);
  config = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
  assert.ok(config.includes('user-new-model')); assert.ok(config.includes('original.exe')); assert.ok(!config.includes('mcp_servers.wechat_bridge'));
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').trim(), '保留浏览器偏好');
  assert.ok(!fs.readFileSync(path.join(dir, 'hooks.json'), 'utf8').includes('hook.mjs'));
});
