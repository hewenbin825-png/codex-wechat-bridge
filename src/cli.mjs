import fs from 'node:fs';
import path from 'node:path';
import { localApi, STATE, stateConfig } from './common.mjs';
const [command = 'status', extra] = process.argv.slice(2);
try {
  if (command === 'status') console.log(JSON.stringify(await localApi('/api/status'), null, 2));
  else if (command === 'login') console.log(JSON.stringify(await localApi('/api/login/start', {})));
  else if (command === 'test') console.log(JSON.stringify(await localApi('/api/test-notification', {})));
  else if (command === 'shutdown') console.log(JSON.stringify(await localApi('/api/shutdown', {})));
  else if (command === 'pause' || command === 'resume') { const s = await localApi('/api/settings', { paused: command === 'pause' }); console.log(JSON.stringify({ paused: s.paused })); }
  else if (command === 'qr') {
    if (!extra || path.extname(extra).toLowerCase() !== '.svg') throw new Error('Provide a local .svg output path');
    const cfg = stateConfig(); const token = fs.readFileSync(path.join(STATE, 'control.token'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/login/qr.svg`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw new Error(`QR not ready (${r.status})`); fs.writeFileSync(extra, await r.text()); console.log(JSON.stringify({ saved: path.resolve(extra) }));
  } else throw new Error('Commands: status, login, qr <path.svg>, test, pause, resume, shutdown');
} catch (e) { console.error(JSON.stringify({ error: e.message, code: e.code || e.name })); process.exitCode = 1; }
