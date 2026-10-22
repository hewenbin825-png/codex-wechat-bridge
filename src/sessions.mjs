import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultCodexHome } from './common.mjs';

export function isRootSession(row) {
  if (!row || row.agent_path || row.agent_role || row.parentThreadId || row.parent_thread_id) return false;
  let source = row.source;
  if (typeof source === 'string' && /^[{\[]/.test(source)) { try { source = JSON.parse(source); } catch { return false; } }
  // Unknown source shapes fail closed; sub-agent roles never obtain task numbers.
  return typeof source === 'string' && ['cli', 'vscode', 'exec', 'appServer', 'app_server'].includes(source);
}

function read(fn) {
  let db;
  try { db = new DatabaseSync(path.join(defaultCodexHome(), 'state_5.sqlite'), { readOnly: true }); return fn(db); }
  finally { db?.close(); }
}
export function lookupSession(id) {
  try {
    const row = read(db => db.prepare('SELECT id,title,cwd,source,agent_path,agent_role,archived FROM threads WHERE id=?').get(id));
    return row ? { ...row, root: isRootSession(row) } : null;
  } catch { return null; }
}
export function monitorSessions() {
  try { return read(db => db.prepare('SELECT id,title,cwd,source,agent_path,agent_role,archived FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 60').all()).filter(isRootSession); }
  catch { return []; }
}
