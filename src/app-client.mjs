import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { defaultCodexHome } from './common.mjs';

const ALLOWED = new Set(['list_threads', 'read_thread', 'send_message_to_thread']);
export function findAppServer(home = defaultCodexHome()) {
  const base = path.join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  try {
    const versions = fs.readdirSync(base).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a,b) => b.localeCompare(a, undefined, {numeric:true}));
    return versions.map(v => path.join(base, v, 'server.mjs')).find(p => fs.statSync(p, {throwIfNoEntry:false})?.isFile()) || null;
  } catch { return null; }
}

export function mcpData(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

// Use the installed official App Tools stdio server, with the capability and
// caller identity inherited by this MCP. No pipe discovery or custom UI driver.
export class AppClient {
  constructor(session, {server = findAppServer(), env = process.env} = {}) { this.session = session; this.server = server; this.env = env; this.pending = new Map(); this.next = 0; this.names = new Map(); }
  async start() {
    if (!this.server || !this.env.CODEX_APP_TOOLS_PIPE_PATH || !/^[0-9a-f-]{36}$/i.test(this.session || '')) throw Object.assign(new Error('Desktop capability unavailable'), {code:'DESKTOP_UNAVAILABLE',preflight:true});
    this.child = spawn(process.execPath, [this.server], {env:this.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stderr.resume(); this.child.stdin.on('error', () => {});
    const stop = () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Desktop connection closed'), {code:'DESKTOP_CLOSED',uncertain:true})); } this.pending.clear(); };
    this.child.on('error', stop); this.child.on('close', stop);
    this.lines = readline.createInterface({input:this.child.stdout});
    this.lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(Object.assign(new Error('Desktop request rejected'), {code:'DESKTOP_REJECTED'})); else pending.resolve(msg.result);
    });
    await this.rpc('initialize', {protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'codex-wechat-task-router',version:'0.1.2'}});
    this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const catalog = await this.rpc('tools/list', {});
    for (const suffix of ALLOWED) {
      const matches = catalog.tools.filter(t => t.name === suffix || t.name.endsWith(`__${suffix}`));
      if (matches.length !== 1) throw Object.assign(new Error('Desktop tool unavailable'), {code:'DESKTOP_TOOL_UNAVAILABLE',preflight:true});
      this.names.set(suffix, matches[0].name);
    }
    this.verifiedAt = Date.now();
    return this;
  }
  healthy() { return !!this.child && !this.child.killed && this.child.exitCode === null && Date.now() - (this.verifiedAt || 0) < 20000; }
  rpc(method, params, timeout = 10000) {
    if (!this.child || this.child.killed || this.child.exitCode !== null) return Promise.reject(Object.assign(new Error('Desktop client not running'), {code:'DESKTOP_UNAVAILABLE',preflight:true}));
    const id = ++this.next;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'Timed out'}})+'\n'); reject(Object.assign(new Error('Desktop request timed out'), {code:'DESKTOP_TIMEOUT',uncertain:true})); },timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
    });
  }
  async call(name, args, turn = '') {
    if (!ALLOWED.has(name) || !this.names.has(name)) throw Object.assign(new Error('Tool is not allowed'), {code:'DESKTOP_TOOL_UNAVAILABLE',preflight:true});
    const result = await this.rpc('tools/call', {name:this.names.get(name),arguments:args,_meta:{'x-codex-turn-metadata':{thread_id:this.session,...(turn ? {turn_id:turn} : {})}}},name === 'send_message_to_thread' ? 45000 : 15000);
    if (result.isError) throw Object.assign(new Error('Desktop tool rejected the request'), {code:'DESKTOP_TOOL_REJECTED'});
    this.verifiedAt = Date.now();
    return mcpData(result);
  }
  async close() { this.lines?.close(); this.child?.stdin.end(); this.child?.kill(); }
}
