import readline from 'node:readline';
import { randomId, VERSION } from './common.mjs';
import { DesktopWorker } from './desktop-worker.mjs';
import {createBootstrap, watchService} from './bootstrap.mjs';
import {questionMarkdown} from './store.mjs';

const connectionId = `mcp-${randomId()}`;
const running = new Map();
const bootstrap=createBootstrap();
const watchdog=watchService(bootstrap);
const api=bootstrap.request;
const desktop = new DesktopWorker({api});
function connectDesktop(message) {
  if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) return;
  let meta = message.params?._meta?.['x-codex-turn-metadata'];
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
  desktop.connect(meta?.thread_id || process.env.CODEX_THREAD_ID);
}
const questionSchema = { type: 'object', additionalProperties: false, required: ['id', 'question'], properties: {
  id: { type: 'string', description: 'Stable question identifier' }, question: { type: 'string' },
  options: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } } }
} };
const tools = [
  { name: 'set_chat_mode',description:'Set notification mode for this calling chat only, after the human explicitly asks here. Default native uses original Codex question cards and no WeChat notifications. WeChat mode sends question/completion reminders through the connected Eris WeChat bridge and displays questions as highlighted chat text, never native cards. Other chats and new forks are unchanged. Never treat this as execution approval.',inputSchema:{type:'object',additionalProperties:false,required:['mode'],properties:{mode:{type:'string',enum:['native','wechat']}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  { name: 'ask_user', description: 'In an explicitly opted-in WeChat chat, create ONE ordinary question and return immediately, without any native card. Render local_question_markdown prominently in the current chat, then wait for the human. The owner may answer in WeChat (forwarded to this original chat) or type locally (record with answer_from_chat). Pending is NOT an answer. Other chats use original Codex questions. Never execution approval.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 1, items: questionSchema }, title: { type: 'string' }, session_id: { type: 'string' }, turn_id: { type: 'string' }, request_key: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'check_answer', description: 'Read an existing WeChat question group. This does not start a new task or submit an answer.', inputSchema: { type: 'object', additionalProperties: false, required: ['request_id'], properties: { request_id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
  { name:'answer_from_chat',description:'Record the human actual typed answer from this calling chat to its exact ordinary question. Use the user text, never infer an answer or permission. Numeric options and free text are supported. First valid answer wins; return an existing answer unchanged if another device already answered.',inputSchema:{type:'object',additionalProperties:false,required:['request_id','question_id','text'],properties:{request_id:{type:'string'},question_id:{type:'string'},text:{type:'string',maxLength:8000}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  { name:'cancel_question',description:'Cancel one ordinary question belonging to this calling chat when the user cancels it or it is no longer needed. Cancellation is not an answer or permission.',inputSchema:{type:'object',additionalProperties:false,required:['request_id'],properties:{request_id:{type:'string'}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  { name: 'get_status', description: 'Check local WeChat bridge connection and pending questions. Does not send messages.', inputSchema: { type: 'object', additionalProperties: false, properties: {} }, annotations: { readOnlyHint: true } }
];
function send(value) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); }
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
function callerSession(message) {
  let meta=message.params?._meta?.['x-codex-turn-metadata'];
  if(typeof meta==='string'){try{meta=JSON.parse(meta);}catch{meta=null;}}
  return meta?.thread_id||process.env.CODEX_THREAD_ID||'';
}
async function callTool(message, state) {
  const { name, arguments: args = {} } = message.params;
  const caller=callerSession(message);
  if(name==='get_status'){
    const status=await api(`/api/status?session_id=${encodeURIComponent(caller||connectionId)}`,undefined,{signal:state.abort.signal,timeout:3000});
    delete status.recent_events;
    return result({...status,desktop_app_tools_available:!!process.env.CODEX_APP_TOOLS_PIPE_PATH,local_form_supported:false,local_form_provider:'original_codex_when_native',mcp_client_revision:'chat-opt-in-v3',local_manager_answers:true,auto_start:watchdog.status(),context_scope:'current_chat'});
  }
  if(name==='set_chat_mode'){
    if(!caller)throw Object.assign(new Error('Calling chat is unavailable'),{code:'MISSING_CALLER'});
    return result(await api('/api/chat-mode',{session_id:caller,mode:args.mode},{signal:state.abort.signal,timeout:3000}));
  }
  if (['check_answer','answer_from_chat','cancel_question'].includes(name)) {
    if (!/^[0-9a-f-]{36}$/i.test(args.request_id || '')) throw new Error('Invalid request ID');
    const record=await api(`/api/requests/${args.request_id}`,undefined,{signal:state.abort.signal,timeout:3000});
    if(!caller||record.session_id!==caller)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT'});
    if(name==='answer_from_chat')return result(await api('/api/answer-from-chat',{session_id:caller,request_id:record.id,question_id:args.question_id,text:args.text},{signal:state.abort.signal,timeout:3000}));
    if(name==='cancel_question'){await api(`/api/requests/${record.id}/cancel`,{},{signal:state.abort.signal,timeout:3000});return result({request_id:record.id,status:'cancelled',answers:record.answers});}
    return result(record);
  }
  if (name !== 'ask_user') throw new Error('Unknown tool');
  if(!Array.isArray(args.questions)||args.questions.length!==1)throw Object.assign(new Error('Use one question per call; issue separate concurrent calls for multiple questions'),{code:'ONE_QUESTION_PER_CALL'});
  if(caller&&args.session_id&&args.session_id!==caller)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT'});
  if(!caller)throw Object.assign(new Error('Calling chat is unavailable'),{code:'MISSING_CALLER'});
  const input = { ...args,local_available:true,presentation:'chat_text', session_id: caller,
    turn_id: args.turn_id || '', request_key: args.request_key || `${connectionId}:${message.id}` };
  const record = await api('/api/ask', input, { signal: state.abort.signal, timeout: 5000 });
  return result({ request_id: record.id, status: record.status, answers: record.answers,
    questions:record.questions,mode:'wechat',presentation:'chat_text',local_question_markdown:questionMarkdown(record),
    instruction:'Display local_question_markdown in this chat without a question card. Wait for a real human answer. WeChat answers are forwarded to this exact chat; typed local answers use answer_from_chat. Pending, errors, silence and cancellation are never answers or execution approval.' });
}
async function onMessage(message) {
  if(message.method===undefined)return;
  connectDesktop(message);
  if (message.method === 'notifications/cancelled') {
    const state = running.get(String(message.params?.requestId));
    if (state) state.abort.abort();
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25','2026-07-28'];
    return send({ id: message.id, result: { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-wechat-bridge', version: VERSION }, instructions: 'Ordinary user questions only. A WeChat answer is scoped to the exact pending question, never general authorization.' } });
  }
  if (message.method === 'ping') return send({ id: message.id, result: {} });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools } });
  if (message.method !== 'tools/call') return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  const state = { abort: new AbortController() }; running.set(String(message.id), state);
  try { send({ id: message.id, result: await callTool(message, state) }); }
  catch (e) {
    send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: e.code==='ONE_QUESTION_PER_CALL'?'请把每道题拆成独立 ask_user 调用，每次 questions 仅一题；需要多题时可并发调用。尚未创建问题，也没有用户答案。':`微信问答未完成（${e.code || e.name}）。请在 Codex 内直接询问用户，不能把此错误当作回答或许可。` }] } });
  } finally { running.delete(String(message.id)); }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (Buffer.byteLength(line) > 65536) return send({ id: null, error: { code: -32600, message: 'Request too large' } });
  try { const parsed = JSON.parse(line); onMessage(parsed).catch(() => {}); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
});
lines.on('close', async () => {
  watchdog.close();
  await desktop.close();
  for (const state of running.values()) state.abort.abort();
});
