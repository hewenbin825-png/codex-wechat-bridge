import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DesktopHub} from '../src/desktop-hub.mjs';
import {serve} from '../src/service.mjs';
import {ROOT,sleep} from '../src/common.mjs';
import {supportsForms,questionForm,nativeAnswerTargets} from '../src/local-input.mjs';
import {handleHook} from '../src/hook.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',WORKER='44444444-4444-4444-8444-444444444444';
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-dual-')),store=new Store(path.join(dir,'bridge.sqlite'));
  for(const id of [A,B])store.setChatMode(id,'wechat');
  const metadata=new Map([[A,{root:true,title:'A'}],[B,{root:true,title:'B'}]]);
  const bridge=new Bridge({store,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>metadata.get(id),desktopWaitMs:0});
  bridge.creds={peer:'owner',contextToken:'dummy-context'};
  let seq=0;const incoming=text=>({message_id:String(++seq),from_user_id:'owner',message_type:1,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text}}]});
  const ask=(session=A,key=String(++seq))=>bridge.ask({presentation:'chat_text',session_id:session,request_key:key,local_available:true,questions:[{id:'choice',question:'下一步？',options:[{label:'继续'},{label:'暂停'}]}]});
  const rawClose=store.close.bind(store);let closed=false;store.close=()=>{if(!closed){closed=true;rawClose();}};
  t.after(async()=>{await bridge.close();store.close();});return{dir,store,bridge,ask,incoming,metadata};
}
test('local HTTP choices and text compete with WeChat without overwriting the first valid answer',async t=>{
  const f=fixture(t),app=await serve({state:f.dir,port:0,bridge:f.bridge,listen:false});t.after(()=>app.close());
  const token=fs.readFileSync(path.join(f.dir,'control.token'),'utf8'),base=`http://127.0.0.1:${app.port}`;
  const local=async(r,body,headers={Authorization:`Bearer ${token}`})=>{const response=await fetch(`${base}/api/requests/${r.id}/answer`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,data:await response.json()};};
  const r=f.ask();assert.equal((await local(r,{question_id:'choice',choice:1},{})).status,401);
  assert.equal((await local(r,{question_id:'bad',choice:1})).status,404);
  assert.equal((await local(r,{question_id:'choice',choice:99})).status,400);
  assert.equal((await local(r,{question_id:'choice',choice:2})).data.accepted,true);
  await f.bridge.receive(f.incoming(`${r.questions[0].number}.1`));
  assert.equal(f.store.request(r.id).answers.choice.source,'local');assert.deepEqual(f.store.request(r.id).answers.choice.answers,['暂停']);
  assert.equal((await local(r,{question_id:'choice',text:'late'})).data.accepted,false);
  const b=f.ask(B);await f.bridge.receive(f.incoming(`${b.questions[0].number}.1`));
  assert.equal((await local(b,{question_id:'choice',text:'late-local'})).data.accepted,false);
  const c=f.ask();assert.equal((await local(c,{question_id:'choice',text:'1',source:'local'})).data.accepted,true);assert.deepEqual(f.store.request(c.id).answers.choice.answers,['1']);
  const d=f.ask();f.store.cancel(d.id);assert.equal((await local(d,{question_id:'choice',choice:1})).data.accepted,false);
});
test('computer questions remain answerable when WeChat is unavailable or delivery fails',async t=>{
  const f=fixture(t);f.bridge.creds=null;const a=f.ask();assert.equal(a.status,'pending');
  assert.equal(f.bridge.answerLocal(a.id,{question_id:'choice',text:'本地回答'}).accepted,true);
  f.bridge.creds={peer:'owner',contextToken:'dummy-context'};f.bridge.api.send=async()=>{throw Object.assign(new Error('failed'),{code:'FAILED'});};
  const b=f.ask();await f.bridge.drainOnce();assert.equal(f.store.request(b.id).status,'pending');
  assert.equal(f.bridge.answerLocal(b.id,{question_id:'choice',choice:2}).accepted,true);
});
test('different questions in one group can be answered on different devices without renumbering',async t=>{
  const f=fixture(t),request=f.bridge.ask({presentation:'chat_text',session_id:A,request_key:'mixed-devices',local_available:true,questions:[{id:'first',question:'第一题',options:[{label:'继续'}]},{id:'second',question:'第二题'}]});
  const [first,second]=request.questions;
  f.bridge.answerLocal(request.id,{question_id:'first',choice:1});assert.equal(f.store.request(request.id).status,'pending');
  assert.equal(f.store.pending()[0].questions[1].number,second.number);
  await f.bridge.receive(f.incoming(`${second.number}.在微信补充第二题`));
  const result=f.store.request(request.id);assert.equal(result.status,'answered');assert.equal(result.answers.first.source,'local');assert.equal(result.answers.second.source,'wechat');assert.equal(result.questions[0].number,first.number);
});
test('answered question numbers route later supplements to their original root without allocating a task',async t=>{
  const f=fixture(t),hub=new DesktopHub(f.bridge,()=>[]);hub.register({worker_id:WORKER,session_id:A});
  const a=f.ask(A),b=f.ask(B);f.bridge.answerLocal(a.id,{question_id:'choice',choice:1});
  await f.bridge.receive(f.incoming(`${a.questions[0].number}.按完 k4 后又按了 k5`));
  const job=hub.poll({worker_id:WORKER}).job;assert.equal(job.session_id,A);assert.equal(job.question_number,a.questions[0].number);assert.equal(job.task_number,null);assert.match(job.prompt,/按完 k4 后又按了 k5/);
  hub.result({worker_id:WORKER,id:job.id,state:'delivered'});assert.equal(f.store.tasks().length,0);assert.equal(f.store.request(b.id).status,'pending');
  await f.bridge.receive(f.incoming(`${a.questions[0].number}.1`));assert.equal(hub.poll({worker_id:WORKER}).job,null);
  assert.deepEqual(f.store.request(a.id).answers.choice.answers,['继续']);
  const number=a.questions[0].number;const other=new Store(path.join(f.dir,'bridge.sqlite'));assert.equal(other.questionByNumber(number).request.session_id,A);other.close();
});
test('unknown archived cancelled and disconnected question supplements never guess or queue a destination',async t=>{
  const f=fixture(t),hub=new DesktopHub(f.bridge,()=>[]);hub.register({worker_id:WORKER,session_id:A});
  const a=f.ask();f.bridge.answerLocal(a.id,{question_id:'choice',choice:1});
  await f.bridge.receive(f.incoming('999.补充'));assert.equal(hub.poll({worker_id:WORKER}).job,null);
  f.metadata.get(A).archived=true;await f.bridge.receive(f.incoming(`${a.questions[0].number}.归档补充`));assert.equal(hub.poll({worker_id:WORKER}).job,null);
  f.metadata.get(A).archived=false;hub.unregister({worker_id:WORKER});await f.bridge.receive(f.incoming(`${a.questions[0].number}.未连接补充`));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
  const b=f.ask();f.store.cancel(b.id);await f.bridge.receive(f.incoming(`${b.questions[0].number}.取消补充`));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
});
test('local forms negotiate capability, keep stable question numbers and hooks never block local input',async()=>{
  assert.equal(supportsForms({}),false);assert.equal(supportsForms({elicitation:{url:{}}}),false);assert.equal(supportsForms({elicitation:{form:{}}}),true);assert.equal(supportsForms({elicitation:{}}),true);
  const form=questionForm({title:'普通问题'},{number:5,question:'下一步',options:[{label:'继续'},{label:'暂停'}]});
  assert.match(form.message,/第5题/);assert.deepEqual(form.requestedSchema.properties.choice.enum,['1','2','custom']);assert.deepEqual(form.requestedSchema.required,['choice']);
  for(const tool_name of ['request_user_input','request_user_input_async','request_permissions'])assert.deepEqual(await handleHook({hook_event_name:'PreToolUse',tool_name},{api:async()=>{throw new Error('must not be called');}}),{});
});
async function mcpFixture(t,enabled=true){
  const f=fixture(t);if(!enabled)f.store.setChatMode(A,'native');
  const app=await serve({state:f.dir,port:0,bridge:f.bridge,listen:false});t.after(()=>app.close());
  const env={...process.env,CODEX_WECHAT_STATE:f.dir,CODEX_THREAD_ID:A};delete env.CODEX_APP_TOOLS_PIPE_PATH;delete env.CODEX_APP_TOOLS_CALLER_HOST_ID;
  const child=spawn(process.execPath,[path.join(ROOT,'src','mcp.mjs')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const messages=[],waiting=new Map();
  const send=value=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  readline.createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);messages.push(message);waiting.get(String(message.id))?.(message);});
  let nextId=0;const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>reject(new Error('MCP test deadline')),10000);waiting.set(String(id),m=>{clearTimeout(timer);resolve(m);});send({id,method,params});});
  const call=(name,args={},caller=A)=>rpc('tools/call',{name,arguments:args,_meta:{'x-codex-turn-metadata':{thread_id:caller}}});
  t.after(()=>{child.stdin.end();child.kill();});await rpc('initialize',{protocolVersion:'2026-07-28',capabilities:{elicitation:{form:{}}}});
  const ask=(key='q')=>call('ask_user',{request_key:key,title:'聊天文字问题',questions:[{id:'choice',question:'下一步？',options:[{label:'继续'},{label:'暂停'}]}]});
  return{...f,child,messages,send,rpc,call,ask};
}

test('default chat rejects WeChat questions and completion before allocating numbers or native forms',async t=>{
  const f=await mcpFixture(t,false);const reply=await f.ask();assert.equal(reply.result.isError,true);
  assert.equal(f.store.pending().length,0);assert.equal(f.store.meta('question_counter'),'0');
  assert.equal(f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'t'}).suppressed,'chat_mode_native');assert.equal(f.store.tasks().length,0);
  assert.equal((await f.call('get_status')).result.structuredContent.chat_mode,'native');
  assert.equal(f.messages.some(m=>m.method==='elicitation/create'),false);
});

test('explicit mode is scoped to caller and does not enable another or a new chat',async t=>{
  const f=await mcpFixture(t,false);f.store.setChatMode(B,'native');
  const mode=(await f.call('set_chat_mode',{mode:'wechat',session_id:B})).result.structuredContent;
  assert.equal(mode.session_id,A);assert.equal(f.store.chatMode(A),'wechat');assert.equal(f.store.chatMode(B),'native');
  const fork='33333333-3333-4333-8333-333333333333';assert.equal(f.store.chatMode(fork),'native');
  const reopened=new Store(path.join(f.dir,'bridge.sqlite'));assert.equal(reopened.chatMode(A),'wechat');assert.equal(reopened.chatMode(B),'native');reopened.close();
  assert.equal((await f.call('set_chat_mode',{mode:'wechat'},fork)).result.isError,true);
});

test('opted-in MCP returns a numbered highlighted question immediately and never requests a native card',async t=>{
  const f=await mcpFixture(t),result=(await f.ask()).result.structuredContent;
  assert.equal(result.status,'pending');assert.equal(result.presentation,'chat_text');assert.deepEqual(result.answers,{});
  assert.match(result.local_question_markdown,/\*\*待你回答｜第1题/);assert.match(result.local_question_markdown,/1\. 继续/);
  assert.equal(f.messages.some(m=>m.method==='elicitation/create'),false);assert.equal(result.native_form_followup,undefined);
  assert.equal((await f.ask()).result.structuredContent.request_id,result.request_id);
  let sent='';f.bridge.api.send=async(c,text)=>{sent=text;};await f.bridge.drainOnce();assert.match(sent,/艾莉丝提醒/);
});

test('a real phone answer queues one exact original-chat delivery, not a task or native refill',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent;const b=f.bridge.ask({presentation:'chat_text',session_id:B,request_key:'b',local_available:true,questions:[{id:'b',question:'另一个聊天'}]});
  await f.bridge.receive(f.incoming('1.自定义回填不再需要\n第二行'));
  const answer=(await f.call('check_answer',{request_id:a.request_id})).result.structuredContent;
  assert.equal(answer.answers.choice.source,'wechat');assert.deepEqual(answer.answers.choice.answers,['自定义回填不再需要\n第二行']);assert.equal(f.store.request(b.id).status,'pending');
  const hub=new DesktopHub(f.bridge,()=>[]);hub.register({worker_id:WORKER,session_id:A});const job=hub.poll({worker_id:WORKER}).job;
  assert.equal(job.session_id,A);assert.equal(job.kind,'question_answer');assert.equal(job.task_number,null);assert.match(job.prompt,/第二行/);
  hub.result({worker_id:WORKER,id:job.id,state:'delivered'});await f.bridge.receive(f.incoming('1.1'));assert.equal(hub.poll({worker_id:WORKER}).job,null);
  assert.equal(f.store.tasks().length,0);assert.equal(f.messages.some(m=>m.method==='elicitation/create'),false);
});

test('typed original-chat choices and custom text win without forcing a second WeChat answer',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent;
  const first=(await f.call('answer_from_chat',{request_id:a.request_id,question_id:'choice',text:'2'})).result.structuredContent;
  assert.equal(first.accepted,true);assert.deepEqual(first.request.answers.choice.answers,['暂停']);assert.equal(first.request.answers.choice.source,'codex');
  await f.bridge.receive(f.incoming('1.1'));assert.deepEqual(f.store.request(a.request_id).answers.choice.answers,['暂停']);
  const b=(await f.ask('custom')).result.structuredContent;const raw='按完 k4 后再改 k5\n保留这段文字';
  assert.deepEqual((await f.call('answer_from_chat',{request_id:b.request_id,question_id:'choice',text:raw})).result.structuredContent.request.answers.choice.answers,[raw]);
});

test('phone-first races retain the true answer when a later local prompt is recorded',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent;await f.bridge.receive(f.incoming('1'));
  const later=(await f.call('answer_from_chat',{request_id:a.request_id,question_id:'choice',text:'2'})).result.structuredContent;
  assert.equal(later.accepted,false);assert.equal(later.request.answers.choice.source,'wechat');assert.deepEqual(later.request.answers.choice.answers,['继续']);
});

test('cross-chat read answer cancel and reused request keys cannot touch another question',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent;
  for(const name of ['check_answer','answer_from_chat','cancel_question'])assert.equal((await f.call(name,{request_id:a.request_id,question_id:'choice',text:'2'},B)).result.isError,true);
  assert.equal((await f.call('ask_user',{request_key:'q',questions:[{id:'b',question:'B'}]},B)).result.isError,true);
  assert.equal(f.store.request(a.request_id).status,'pending');assert.deepEqual(f.store.request(a.request_id).answers,{});
});

test('turn interruption, MCP cancellation and short lease expiry do not discard text questions',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent;
  f.bridge.event({event:'Interrupt',session_id:A});f.bridge.event({event:'SessionEnd',session_id:A});
  f.send({method:'notifications/cancelled',params:{requestId:3}});
  f.store.db.prepare('UPDATE requests SET lease=0 WHERE id=?').run(a.request_id);f.store.sweep();assert.equal(f.store.request(a.request_id).status,'pending');
  f.child.stdin.end();await sleep(40);assert.equal(f.store.request(a.request_id).status,'pending');
  assert.equal(f.bridge.answerFromChat({session_id:A,request_id:a.request_id,question_id:'choice',text:'电脑提示词回答'}).accepted,true);
});

test('disable and clear affect only intended questions and preserve chat modes without interpreting cancellation as an answer',async t=>{
  const f=await mcpFixture(t),a=(await f.ask()).result.structuredContent,b=f.bridge.ask({presentation:'chat_text',session_id:B,request_key:'b',local_available:true,questions:[{id:'b',question:'B'}]});
  await f.call('set_chat_mode',{mode:'native'});assert.equal(f.store.request(a.request_id).status,'cancelled');assert.equal(f.store.request(b.id).status,'pending');assert.deepEqual(f.store.request(a.request_id).answers,{});
  await f.bridge.receive(f.incoming('/clear'));assert.equal(f.store.request(b.id).status,'cancelled');assert.equal(f.store.chatMode(A),'native');assert.equal(f.store.chatMode(B),'wechat');
  const next=f.bridge.ask({presentation:'chat_text',session_id:B,request_key:'new',local_available:true,questions:[{id:'q',question:'新问题'}]});assert.equal(next.questions[0].number,1);
});

test('old MCP clients cannot create native bridge forms after the mode upgrade',async t=>{
  const f=fixture(t);assert.throws(()=>f.bridge.ask({session_id:A,request_key:'legacy',questions:[{id:'q',question:'旧版卡'}]}),e=>e.code==='CLIENT_RELOAD_REQUIRED');
  assert.equal(f.store.pending().length,0);
});

test('completion monitoring includes opted-in roots only and pending text questions suppress completion',async t=>{
  const f=fixture(t);f.store.setChatMode(B,'native');const hub=new DesktopHub(f.bridge,()=>[{id:A},{id:B}]);
  assert.deepEqual(hub.register({worker_id:WORKER,session_id:A}).sessions,[A]);
  const a=f.ask();assert.equal(f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'other'}).suppressed,'waiting_for_answer');
  f.bridge.answerLocal(a.id,{question_id:'choice',choice:1});const payload={type:'agent-turn-complete','thread-id':A,'turn-id':'done','last-assistant-message':'已完成'};
  f.bridge.notify(payload);f.bridge.notify(payload);assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n,1);
  f.store.setChatMode(A,'native');assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='completion'").get().state,'cancelled');
});

test('default SessionStart loads no WeChat question workflow and ordinary native tools remain unmodified',async()=>{
  const result=await handleHook({hook_event_name:'SessionStart',session_id:A},{api:async()=>({chat_mode:'native'}),wake:async()=>{}});
  assert.match(result.hookSpecificOutput.additionalContext,/当前模式=native/);assert.match(result.hookSpecificOutput.additionalContext,/原始问题选择卡/);
  for(const tool_name of ['request_user_input','request_user_input_async'])assert.deepEqual(await handleHook({hook_event_name:'PreToolUse',tool_name}),{});
});

test('multiple questions in one MCP call are rejected before any numbering or send',async t=>{
  const f=await mcpFixture(t),result=await f.call('ask_user',{questions:[{id:'a',question:'A'},{id:'b',question:'B'}]});
  assert.equal(result.result.isError,true);assert.equal(f.store.pending().length,0);assert.equal(f.messages.some(m=>m.method==='elicitation/create'),false);
});

test('a short desktop reconnection delivers the exact answered-question supplement during the same call',async t=>{
  const f=fixture(t),hub=new DesktopHub(f.bridge,()=>[]);f.bridge.desktopWaitMs=600;
  const a=f.ask();f.bridge.answerLocal(a.id,{question_id:'choice',choice:1});
  const delivering=f.bridge.receive(f.incoming(`${a.questions[0].number}.原题的新补充`));
  await sleep(30);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
  hub.register({worker_id:WORKER,session_id:A});await delivering;
  const job=hub.poll({worker_id:WORKER}).job;assert.equal(job.session_id,A);assert.match(job.prompt,/原题的新补充/);assert.equal(f.store.tasks().length,0);
});

test('a permanently disconnected supplement returns unsubmitted and never starts later after the call ended',async t=>{
  const f=fixture(t),hub=new DesktopHub(f.bridge,()=>[]);f.bridge.desktopWaitMs=30;
  const a=f.ask();f.bridge.answerLocal(a.id,{question_id:'choice',choice:1});
  await f.bridge.receive(f.incoming(`${a.questions[0].number}.连接仍未恢复`));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
  hub.register({worker_id:WORKER,session_id:A});assert.equal(hub.poll({worker_id:WORKER}).job,null);
});
