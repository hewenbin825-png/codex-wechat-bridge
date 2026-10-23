import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '2.0.0';
export const STATE = process.env.CODEX_WECHAT_STATE || path.join(ROOT, 'state');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const randomId = () => crypto.randomUUID();
export const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const now = () => Date.now();
export function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function safeError(e) {
  return { code: String(e.code || e.name || 'ERROR').slice(0, 64), status: e.status || null };
}
export function summary(text, limit = 180) {
  const clean = String(text || '').replace(/```[\s\S]*?```/g, '[代码略]')
    .replace(/!?(\[([^\]]*)\])\([^)]*\)/g, '$2')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(sk-[\w-]{12,}|(?:SCT|AT_|UID_)[\w-]{12,})\b/g, '[已隐藏]')
    .replace(/\b(token|secret|api[_-]?key|password)\s*[:=]\s*[^\s,，;；]+/gi, '$1=[已隐藏]')
    .replace(/[\r\n\t]+/g, ' ').replace(/[*#`_]+/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(clean);
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
}
export function stateConfig(state = STATE) {
  return readJson(path.join(state, 'connection.json'), { port: 17349 });
}
export async function localApi(route, body, { state = STATE, signal, timeout = 35000 } = {}) {
  const cfg = stateConfig(state);
  const token = fs.readFileSync(path.join(state, 'control.token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    redirect: 'error'
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Bridge request failed'), { status: response.status, code: data.code || 'BRIDGE_ERROR' });
  return data;
}
export class WindowsVault {
  constructor(state = STATE) { this.file = path.join(state, 'credentials.dpapi'); }
  async transform(action, input) {
    if (process.platform !== 'win32') throw Object.assign(new Error('Windows DPAPI required'), { code: 'WINDOWS_REQUIRED' });
    const shell = process.env.CODEX_WECHAT_POWERSHELL || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return new Promise((resolve, reject) => {
      const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'vault.ps1'), '-Action', action], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let bytes = 0;
      const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Vault timeout'), { code: 'VAULT_TIMEOUT' })); }, 15000);
      child.stdout.on('data', b => { bytes += b.length; if (bytes > 131072) child.kill(); else output += b.toString('utf8'); });
      child.stderr.resume();
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(Object.assign(new Error('Windows credential encryption failed'), { code: 'VAULT_FAILURE' })); });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async load() {
    if (!fs.existsSync(this.file)) return null;
    return JSON.parse(await this.transform('Unprotect', fs.readFileSync(this.file, 'utf8')));
  }
  async save(value) { atomicWrite(this.file, await this.transform('Protect', JSON.stringify(value))); }
}
export function defaultCodexHome() { return process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
