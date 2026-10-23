import readline from 'node:readline';
import { localApi, randomId, sleep, VERSION } from './common.mjs';
import { DesktopWorker } from './desktop-worker.mjs';
import {createBootstrap, watchService} from './bootstrap.mjs';
import {LocalForms,supportsForms,nativeAnswerTargets} from './local-input.mjs';

const connectionId = `mcp-${randomId()}`;
const running = new Map();
const bootstrap=createBootstrap();
const watchdog=watchService(bootstrap);
const api=bootstrap.request;
const desktop = new DesktopWorker({api});
let localFormSupported=false;
const localForms=new LocalForms(send,api);
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
  { name: 'ask_user', description: 'Ask one ordinary question per call in WeChat and on the computer. For 1-3 questions, make separate concurrent calls with distinct request keys; stable global question numbers still distinguish them. Supported clients show a native form; the local manager also accepts choices and free text. First valid answer wins. A phone answer requests native form cancellation, but actual UI closure depends on the client and must be verified separately. Never use for execution approval or invent an answer.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 1, items: questionSchema }, title: { type: 'string' }, session_id: { type: 'string' }, turn_id: { type: 'string' }, request_key: { type: 'string' } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
  { name: 'check_answer', description: 'Read an existing WeChat question group. This does not start a new task or submit an answer.', inputSchema: { type: 'object', additionalProperties: false, required: ['request_id'], properties: { request_id: { type: 'string' } } }, annotations: { readOnlyHint: true } },
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
    return result({...status,desktop_app_tools_available:!!process.env.CODEX_APP_TOOLS_PIPE_PATH,local_form_supported:localFormSupported,local_form_provider:'codex_native',mcp_client_revision:'native-mcp-v2',local_manager_answers:true,auto_start:watchdog.status(),context_scope:'current_chat'});
  }
  if (name === 'check_answer') {
    if (!/^[0-9a-f-]{36}$/i.test(args.request_id || '')) throw new Error('Invalid request ID');
    const record=await api(`/api/requests/${args.request_id}`,undefined,{signal:state.abort.signal,timeout:3000});
    if(!caller||record.session_id!==caller)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT'});
    return result(record);
  }
  if (name !== 'ask_user') throw new Error('Unknown tool');
  if(!Array.isArray(args.questions)||args.questions.length!==1)throw Object.assign(new Error('Use one question per call; issue separate concurrent calls for multiple questions'),{code:'ONE_QUESTION_PER_CALL'});
  if(caller&&args.session_id&&args.session_id!==caller)throw Object.assign(new Error('Question belongs to another chat'),{code:'WRONG_CHAT'});
  const input = { ...args,local_available:true, session_id: caller || args.session_id || connectionId,
    turn_id: args.turn_id || '', request_key: args.request_key || `${connectionId}:${message.id}` };
  let record = await api('/api/ask', input, { signal: state.abort.signal, timeout: 5000 }); state.requestId = record.id;
  if(localFormSupported&&record.status==='pending')state.localForms=localForms.open(record,state.abort.signal);
  const deadline = Date.now() + 86340000;
  let failures = 0;
  while (record.status === 'pending' && Date.now() < deadline && !state.abort.signal.aborted) {
    try { record = await api(`/api/requests/${record.id}/wait`, undefined, { signal: state.abort.signal, timeout: 25000 }); failures = 0; }
    catch (e) { if (state.abort.signal.aborted) throw e; if (++failures >= 4) throw Object.assign(new Error('Bridge disconnected; ask the user in Codex'), { code: 'BRIDGE_DISCONNECTED' }); await sleep(1000); }
    state.localForms?.sync(record);
    const progressToken = message.params?._meta?.progressToken;
    if (progressToken !== undefined && record.status === 'pending') send({ method: 'notifications/progress', params: { progressToken, progress: 0, message: '等待微信或电脑本地回答；先提交的有效答案生效，未自动选择选项。' } });
  }
  if (record.status === 'pending') { await localApi(`/api/requests/${record.id}/cancel`, {}).catch(() => {}); record.status = 'expired'; }
  await localForms.settle();
  return result({ request_id: record.id, status: record.status, answers: record.answers,
    ...(localFormSupported?{native_form_followup:nativeAnswerTargets(record)}:{}),
    ...(record.status === 'answered' ? {} : { instruction: 'Only entries present in answers are actual valid user answers. Unanswered questions were not answered; ask in Codex or explicitly re-ask without assuming approval or a default.' }) });
}
async function onMessage(message) {
  if(localForms.response(message))return;
  if(message.method===undefined)return;
  connectDesktop(message);
  if (message.method === 'notifications/cancelled') {
    const state = running.get(String(message.params?.requestId));
    if (state) { state.abort.abort(); if (state.requestId) localApi(`/api/requests/${state.requestId}/cancel`, {}, { timeout: 2000 }).catch(() => {}); }
    return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    localFormSupported=supportsForms(message.params?.capabilities);
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25','2026-07-28'];
    return send({ id: message.id, result: { protocolVersion: supported.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'codex-wechat-bridge', version: VERSION }, instructions: 'Ordinary user questions only. A WeChat answer is scoped to the exact pending question, never general authorization.' } });
  }
  if (message.method === 'ping') return send({ id: message.id, result: {} });
  if (message.method === 'tools/list') return send({ id: message.id, result: { tools } });
  if (message.method !== 'tools/call') return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  const state = { abort: new AbortController() }; running.set(String(message.id), state);
  try { send({ id: message.id, result: await callTool(message, state) }); }
  catch (e) {
    if (state.requestId) await localApi(`/api/requests/${state.requestId}/cancel`, {}, { timeout: 1500 }).catch(() => {});
    send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: e.code==='ONE_QUESTION_PER_CALL'?'请把每道题拆成独立 ask_user 调用，每次 questions 仅一题；需要多题时可并发调用。尚未创建问题，也没有用户答案。':`微信问答未完成（${e.code || e.name}）。请在 Codex 内直接询问用户，不能把此错误当作回答或许可。` }] } });
  } finally { state.localForms?.close();running.delete(String(message.id)); }
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (Buffer.byteLength(line) > 65536) return send({ id: null, error: { code: -32600, message: 'Request too large' } });
  try { const parsed = JSON.parse(line); onMessage(parsed).catch(() => {}); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
});
lines.on('close', async () => {
  watchdog.close();
  await desktop.close();
  for (const state of running.values()) { state.abort.abort(); if (state.requestId) await localApi(`/api/requests/${state.requestId}/cancel`, {}, { timeout: 1000 }).catch(() => {}); }
});
