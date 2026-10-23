import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATE, atomicWrite, defaultCodexHome, hash, localApi, randomId, summary } from './common.mjs';
import {createBootstrap} from './bootstrap.mjs';

export async function handleHook(input, { api = localApi, state = STATE, skillPath = path.join(defaultCodexHome(),'skills','wechat-task-qa','SKILL.md'), wake = () => {} } = {}) {
  const event = input.hook_event_name;
  const context = { session_id: String(input.session_id || ''), turn_id: String(input.turn_id || ''), cwd: String(input.cwd || '') };
  if (event === 'SessionStart') {
    await wake();
    await api('/api/events', { event, ...context }, { timeout: 1000 }).catch(() => {});
    let skill='';try{skill=fs.readFileSync(skillPath,'utf8').replace(/^---[\s\S]*?---\s*/,'').slice(0,6500);}catch{}
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `自动应用全局 wechat-task-qa skill，无需用户再提到微信。普通问询同时允许微信和电脑本地回答，先收到的有效答案生效。优先使用 mcp__wechat_bridge__ask_user 的双端问答；不拦截电脑原生提问。已答题仍可用“题号.补充文字”投递原聊天。仅主任务完成通知，子智能体完成不通知。session_id=${context.session_id}。服务不可用时直接在 Codex 提问，不能把超时或错误当作回答。执行权限审批继续使用 Codex 原审批。\n${skill}` } };
  }
  if (event === 'PreToolUse') {
    const name = String(input.tool_name || '');
    if (/mcp__wechat_bridge__ask_user$/.test(name)) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input,
        session_id: context.session_id, turn_id: context.turn_id,
        request_key: `${context.session_id}:${context.turn_id}:${input.tool_use_id || hash(JSON.stringify(input.tool_input))}` } } };
    }
    if (/(^|__)(request_user_input|request_user_input_async)$/.test(name)) {
      // Local ordinary questions remain available even while WeChat is ready.
      return {};
    }
    return {};
  }
  if (event === 'Stop') {
    if (input.agent_id || input.agent_type || input.parent_thread_id) return {};
    const payload = { type: 'agent-turn-complete', 'thread-id': context.session_id, 'turn-id': context.turn_id, cwd: context.cwd, 'last-assistant-message': summary(input.last_assistant_message) };
    if (context.session_id) atomicWrite(path.join(state, 'spool', `${randomId()}.json`), JSON.stringify({ kind: 'notify', payload }));
    await wake();
    return {};
  }
  if (['Interrupt', 'SessionEnd'].includes(event)) await api('/api/events', { event, ...context }, { timeout: 900 }).catch(() => {});
  return {};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdin.setEncoding('utf8');
    let text = ''; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 1048576) throw new Error('Oversized hook input'); }
    const bootstrap=createBootstrap();
    process.stdout.write(JSON.stringify(await handleHook(JSON.parse(text),{wake:()=>bootstrap.ensure({timeout:1200}).catch(()=>{})})));
  } catch { process.stdout.write('{}'); }
}
