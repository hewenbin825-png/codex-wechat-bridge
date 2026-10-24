import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import qr from '../vendor/qrcode.cjs';
import { ROOT, STATE, WindowsVault, atomicWrite, randomId, safeError, sleep, VERSION } from './common.mjs';
import { Store } from './store.mjs';
import { WeChatApi } from './wechat.mjs';
import { Bridge } from './bridge.mjs';
import { lookupSession, monitorSessions } from './sessions.mjs';
import { DesktopHub } from './desktop-hub.mjs';
import {DotRouter} from './dot-router.mjs';
import {startDotWatch} from './bootstrap.mjs';

export function lookupTitle(session) { return lookupSession(session)?.title || ''; }
export async function serve({ state = STATE, port = 17349, bridge: supplied, listen = true, dotVault, dotWebhook } = {}) {
  // Reserve the listener before opening shared state or polling WeChat. A failed
  // duplicate launch must never remain as a second background database writer.
  const starting=(req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"Service starting"}');};
  const server=http.createServer(starting);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  let store,bridge,dot,dotWatch,timer,cleanup;
  try {
  fs.mkdirSync(state, { recursive: true }); fs.mkdirSync(path.join(state, 'spool'), { recursive: true });
  const tokenPath = path.join(state, 'control.token');
  if (!fs.existsSync(tokenPath)) atomicWrite(tokenPath, crypto.randomBytes(32).toString('hex'));
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  store = supplied?.store || new Store(path.join(state, 'bridge.sqlite'));
  bridge = supplied || await new Bridge({ store, api: new WeChatApi(), vault: new WindowsVault(state), sessionLookup: lookupSession }).init();
  const desktop = new DesktopHub(bridge, supplied ? () => [] : monitorSessions);
  try {dot=await new DotRouter({bridge,store,vault:dotVault||new WindowsVault(path.join(state,'dot')),webhook:dotWebhook}).init();}
  catch(e){bridge.dot=null;store.audit('dot_startup_error',safeError(e));}
  dotWatch=!supplied&&dot?.enabled()?startDotWatch({state}):null;
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'));
  const script = fs.readFileSync(path.join(ROOT, 'ui', 'app.js'));
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const readBody = async req => {
    req.setEncoding('utf8');
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw Object.assign(new Error('Request too large'), { status: 413 }); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  };
  server.removeListener('request',starting);
  server.on('request',async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return json(res, 403, { error: 'Local origin required' });
    const url = new URL(req.url, `http://${expectedHost}`);
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.method === 'GET' && url.pathname === '/app.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); res.end(script); return; }
    const presented = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!crypto.timingSafeEqual(crypto.createHash('sha256').update(presented).digest(), crypto.createHash('sha256').update(token).digest())) return json(res, 401, { error: 'Local authorization required' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, bridge.status(url.searchParams.get('session_id')||''));
      if(req.method==='POST'&&url.pathname==='/api/chat-mode')return json(res,200,bridge.setChatMode(await readBody(req)));
      if(req.method==='POST'&&url.pathname==='/api/answer-from-chat')return json(res,200,bridge.answerFromChat(await readBody(req)));
      if (url.pathname.startsWith('/api/dot/')) {
        if(!dot)return json(res,503,{error:'Dot connector unavailable; existing WeChat flow remains available'});
        if(req.method==='GET'&&url.pathname==='/api/dot/status')return json(res,200,dot.status());
        if(req.method==='POST'&&url.pathname==='/api/dot/configure')return json(res,200,dot.configure(await readBody(req)));
        if(req.method==='POST'&&url.pathname==='/api/dot/rpc')return json(res,200,await dot.rpc(await readBody(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/login/start') { await readBody(req); return json(res, 200, await bridge.startLogin()); }
      if (req.method === 'POST' && url.pathname === '/api/login/verify') {
        const body = await readBody(req);
        if (!bridge.login || bridge.login.status !== 'need_verifycode' || !/^\d{1,12}$/.test(String(body.code))) return json(res, 400, { error: 'No verification code is currently requested' });
        bridge.login.verifyCode = String(body.code); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/login/qr.svg') {
        if (!bridge.login || !['wait', 'scaned', 'need_verifycode', 'scaned_but_redirect'].includes(bridge.login.status)) return json(res, 404, { error: 'No active QR code' });
        const code = qr(0, 'M'); code.addData(bridge.login.qrUrl); code.make();
        res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(code.createSvgTag({ cellSize: 7, margin: 28, scalable: true })); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') { const b = await readBody(req); if (typeof b.paused !== 'boolean') return json(res, 400, { error: 'paused must be boolean' }); store.meta('paused', b.paused); return json(res, 200, bridge.status()); }
      if (req.method === 'POST' && url.pathname === '/api/test-notification') {
        await readBody(req); if (!bridge.ready()) return json(res, 409, { error: '请先绑定，并在微信发送“激活”。' });
        return json(res, 200, store.enqueue({ key: `test:${randomId()}`, kind: 'test', peer: bridge.creds.peer, text: '【Codex 微信连接测试】\n这是一条由本机桥接服务发送的测试通知。收到后请回复“收到”。', ttl_ms: 600000 }));
      }
      if (req.method === 'POST' && url.pathname === '/api/events') return json(res, 200, bridge.event(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/desktop/register') return json(res, 200, desktop.register(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/desktop/unregister') return json(res,200,desktop.unregister(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/desktop/poll') return json(res, 200, desktop.poll(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/desktop/result') return json(res, 200, desktop.result(await readBody(req)));
      if (req.method === 'POST' && url.pathname === '/api/ask') return json(res, 200, bridge.ask(await readBody(req)));
      const match = /^\/api\/requests\/([0-9a-f-]{36})(\/wait|\/cancel|\/answer)?$/.exec(url.pathname);
      if (match) {
        if (!store.request(match[1])) return json(res, 404, { error: 'Unknown request' });
        if (req.method === 'POST' && match[2] === '/cancel') { await readBody(req); store.cancel(match[1]); bridge.emit('changed'); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && match[2] === '/answer') return json(res,200,bridge.answerLocal(match[1],await readBody(req)));
        if (req.method === 'GET') {
          store.renew(match[1]); store.sweep();
          if (match[2] === '/wait' && store.request(match[1]).status === 'pending') {
            await new Promise(resolve => {
              const finish = () => { clearTimeout(timer); bridge.off('answer', answered); bridge.off('changed', finish); res.off('close', finish); resolve(); };
              const answered = id => { if (id === match[1]) finish(); };
              const timer = setTimeout(finish, 20000); bridge.on('answer', answered); bridge.on('changed', finish); res.on('close', finish);
            });
          }
          if (!res.destroyed) return json(res, 200, store.request(match[1]));
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') { await readBody(req); json(res, 200, { ok: true }); setTimeout(() => close(), 50); return; }
      json(res, 404, { error: 'Unknown endpoint' });
    } catch (e) { json(res, e.status || 400, { error: e.message || 'Operation failed', code: e.code || 'BRIDGE_ERROR' }); }
  });
  let closing = false;
  const tick = async () => {
    try {
      desktop.sweep();
      for (const name of fs.readdirSync(path.join(state, 'spool')).filter(x => /^[0-9a-f-]+\.json$/.test(x)).slice(0, 100)) {
        const file = path.join(state, 'spool', name);
        try { const stat = fs.statSync(file); if (stat.size > 65536) { fs.unlinkSync(file); continue; } bridge.event(JSON.parse(fs.readFileSync(file, 'utf8'))); fs.unlinkSync(file); }
        catch (e) { store.audit('spool_error', safeError(e)); }
      }
      await bridge.drainOnce();
      dot?.tick().catch(e=>store.audit('dot_delivery_error',safeError(e)));
    } catch (e) { store.audit('service_tick_error', safeError(e)); }
  };
  timer = setInterval(tick, 1000); cleanup = setInterval(() => store.prune(), 3600000);
  const pollPromise = listen ? bridge.pollLoop() : Promise.resolve();
  async function close() {
    if (closing) return; closing = true; clearInterval(timer); clearInterval(cleanup);dotWatch?.kill();await bridge.close();await dot?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await Promise.race([pollPromise, sleep(1200)]); store.close();
  }
  atomicWrite(path.join(state, 'connection.json'), JSON.stringify({ port: server.address().port, pid: process.pid, version: VERSION }));
  return { server, bridge, close, port: server.address().port };
  }catch(e){
    clearInterval(timer);clearInterval(cleanup);dotWatch?.kill();
    await bridge?.close();await dot?.close();if(!supplied)store?.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw e;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await serve({ port: Number(process.env.CODEX_WECHAT_PORT || 17349) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close());
    process.stderr.write(`Codex WeChat Bridge listening on 127.0.0.1:${app.port}\n`);
  } catch (e) { process.stderr.write(`Bridge startup failed: ${JSON.stringify(safeError(e))}\n`); process.exitCode = 1; }
}
