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
    const status=await api(`/api/status?session_id=${encodeURIComponent(context.session_id)}`,undefined,{timeout:1000}).catch(()=>null);
    const enabled=status?.chat_mode==='wechat';
    let skill='';if(enabled)try{skill=fs.readFileSync(skillPath,'utf8').replace(/^---[\s\S]*?---\s*/,'').slice(0,6500);}catch{}
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `微信模式按聊天单独保存，默认关闭，不能因全局 skill 或其他聊天开启而自动启用。session_id=${context.session_id}。当前模式=${enabled?'wechat':'native'}${status?'':'（服务状态未确认）'}。${enabled?'本聊天已开启微信模式：普通问题以聊天中的醒目文字及微信提醒呈现，不调用原生问题卡，不使用 computer-use 回填。手机答案投递原聊天，电脑直接文字回答用 answer_from_chat 记录，先到有效答案生效。仅本聊天主任务完成发通知。':'使用 Codex 原始问题选择卡，不发微信问询或完成通知。只有用户在本聊天明确要求微信通知时，应用 wechat-task-qa 并用 set_chat_mode 开启。'}新聊天和分叉不继承开关；执行审批始终使用 Codex 原流程。\n${skill}` } };
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
