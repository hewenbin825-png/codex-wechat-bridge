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
  const metadata=new Map([[A,{root:true,title:'A'}],[B,{root:true,title:'B'}]]);
  const bridge=new Bridge({store,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>metadata.get(id),desktopWaitMs:0});
  bridge.creds={peer:'owner',contextToken:'dummy-context'};
  let seq=0;const incoming=text=>({message_id:String(++seq),from_user_id:'owner',message_type:1,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text}}]});
  const ask=(session=A,key=String(++seq))=>bridge.ask({session_id:session,request_key:key,local_available:true,questions:[{id:'choice',question:'下一步？',options:[{label:'继续'},{label:'暂停'}]}]});
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
  const f=fixture(t),request=f.bridge.ask({session_id:A,request_key:'mixed-devices',local_available:true,questions:[{id:'first',question:'第一题',options:[{label:'继续'}]},{id:'second',question:'第二题'}]});
  const [first,second]=request.questions;
  f.bridge.answerLocal(request.id,{question_id:'first',choice:1});assert.equal(f.store.request(request.id).status,'pending');
  assert.equal(f.store.pending()[0].questions[1].number,second.number);
  await f.bridge.receive(f.incoming(`${second.number}.在微信补充第二题`));
  const result=f.store.request(request.id);assert.equal(result.status,'answered');assert.equal(result.answers.first.source,'local');assert.equal(result.answers.second.source,'wechat');assert.equal(result.questions[0].number,first.number);
});
test('answered question numbers route later supplements to their original root without allocating a task',async t=>{
  const f=fixture(t),hub=new DesktopHub(f.bridge,()=>[]);hub.register({worker_id:WORKER,session_id:A});
  const a=f.ask(A),b=f.ask(B);await f.bridge.receive(f.incoming(`${a.questions[0].number}.1`));
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
async function mcpFixture(t,protocolVersion='2025-11-25'){
  const f=fixture(t),app=await serve({state:f.dir,port:0,bridge:f.bridge,listen:false});t.after(()=>app.close());
  const env={...process.env,CODEX_WECHAT_STATE:f.dir,CODEX_THREAD_ID:A};delete env.CODEX_APP_TOOLS_PIPE_PATH;delete env.CODEX_APP_TOOLS_CALLER_HOST_ID;
  const child=spawn(process.execPath,[path.join(ROOT,'src','mcp.mjs')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const messages=[],waiting=new Map();
  const send=value=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  readline.createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);messages.push(message);waiting.get(String(message.id))?.(message);});
  let nextId=0;const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++nextId;const timer=setTimeout(()=>reject(new Error('MCP test deadline')),12000);waiting.set(String(id),m=>{clearTimeout(timer);resolve(m);});send({id,method,params});});
  t.after(()=>{child.stdin.end();child.kill();});await rpc('initialize',{protocolVersion,capabilities:{elicitation:{form:{}}}});
  const ask=()=>rpc('tools/call',{name:'ask_user',arguments:{title:'双端普通问题',questions:[{id:'choice',question:'下一步？',options:[{label:'继续'},{label:'暂停'}]}]}});
  const waitForm=async()=>{for(let i=0;i<100;i++){const message=messages.find(m=>m.method==='elicitation/create');if(message)return message;await sleep(20);}throw new Error('No native form request');};
  return{...f,child,messages,send,rpc,ask,waitForm};
}
test('real MCP local form acceptance returns the computer answer to the same waiting call',async t=>{
  const f=await mcpFixture(t),reply=f.ask(),form=await f.waitForm();
  f.send({id:form.id,result:{action:'accept',content:{choice:'2',text:''}}});
  const result=(await reply).result.structuredContent;assert.equal(result.status,'answered');assert.deepEqual(result.answers.choice.answers,['暂停']);assert.equal(result.answers.choice.source,'codex');
});
test('real MCP WeChat answer emits native cancellation and rejects its late response',async t=>{
  const f=await mcpFixture(t),reply=f.ask(),form=await f.waitForm();const group=f.store.pending()[0];
  await f.bridge.receive(f.incoming(`${group.questions[0].number}.1`));const result=(await reply).result.structuredContent;
  f.send({id:form.id,result:{action:'accept',content:{text:'迟到答案',choice:'custom'}}});await sleep(50);
  assert.equal(result.answers.choice.source,'wechat');assert.deepEqual(f.store.request(group.id).answers.choice.answers,['继续']);
  assert.equal(result.native_form_followup[0].request_id,group.id);assert.equal(result.native_form_followup[0].option_number,1);assert.equal(result.native_form_followup[0].answer_text,'继续');assert.equal(result.native_form_followup[0].ui_state,'unverified');
  assert.ok(f.messages.some(m=>m.method==='notifications/cancelled'&&m.params.requestId===form.id));
});

test('native refill targets preserve actual phone text and never fabricate local, missing, cancelled or ambiguous choices',()=>{
  const record={id:'request',session_id:A,question_epoch:3,title:'普通问题',status:'answered',questions:[{id:'q',number:6,question:'请补充',options:[{label:'继续'},{label:'暂停'}]}],answers:{q:{source:'wechat',answers:['原样文字\n第二行']}}};
  const [target]=nativeAnswerTargets(record);assert.equal(target.session_id,A);assert.equal(target.number,6);assert.equal(target.answer_text,'原样文字\n第二行');assert.equal(target.option_number,null);assert.equal(target.requires_user_ui_authorization,true);
  record.answers.q.answers=['暂停'];assert.equal(nativeAnswerTargets(record)[0].option_number,2);
  record.questions[0].options.push({label:'暂停'});assert.equal(nativeAnswerTargets(record)[0].option_number,null);
  for(const source of ['codex','local',undefined]){record.answers.q.source=source;assert.deepEqual(nativeAnswerTargets(record),[]);}
  record.answers.q.source='wechat';record.answers.q.answers=[];assert.deepEqual(nativeAnswerTargets(record),[]);
  record.answers.q.answers=['真实答案'];for(const status of ['pending','cancelled','expired']){record.status=status;assert.deepEqual(nativeAnswerTargets(record),[]);}
});

test('independent native question calls finish individually while other questions remain pending',async t=>{
  const f=await mcpFixture(t);
  const ask=(key)=>f.rpc('tools/call',{name:'ask_user',arguments:{request_key:key,questions:[{id:'choice',question:key,options:[{label:'继续'},{label:'暂停'}]}]}});
  let secondFinished=false;const first=ask('first'),second=ask('second').then(value=>{secondFinished=true;return value;});
  for(let i=0;i<100&&f.messages.filter(m=>m.method==='elicitation/create').length<2;i++)await sleep(20);
  const forms=f.messages.filter(m=>m.method==='elicitation/create');assert.equal(forms.length,2);
  const firstGroup=f.store.byKey('first'),secondGroup=f.store.byKey('second');
  await f.bridge.receive(f.incoming(`${firstGroup.questions[0].number}.1`));assert.equal((await first).result.structuredContent.status,'answered');
  assert.equal(secondFinished,false);assert.equal(f.store.request(secondGroup.id).status,'pending');
  const firstForm=forms.find(form=>form.params.message.includes('：first'));
  assert.ok(f.messages.some(m=>m.method==='notifications/cancelled'&&m.params.requestId===firstForm.id));
  f.send({id:firstForm.id,result:{action:'accept',content:{choice:'2'}}});
  await f.bridge.receive(f.incoming(`${secondGroup.questions[0].number}.2`));assert.equal((await second).result.structuredContent.status,'answered');
  assert.deepEqual(f.store.request(firstGroup.id).answers.choice.answers,['继续']);
});

test('batched native question calls are rejected before side effects, with an instruction to call each separately',async t=>{
  const f=await mcpFixture(t),result=await f.rpc('tools/call',{name:'ask_user',arguments:{questions:[{id:'a',question:'A'},{id:'b',question:'B'}]}});
  assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/独立 ask_user/);
  assert.equal(f.store.pending().length,0);assert.equal(f.messages.some(m=>m.method==='elicitation/create'),false);
});

test('modern native forms use numeric cancellation IDs and settle the client response before returning the phone answer',async t=>{
  const f=await mcpFixture(t,'2026-07-28'),reply=f.ask(),form=await f.waitForm();
  assert.equal(f.messages.find(m=>m.result?.serverInfo).result.protocolVersion,'2026-07-28');
  assert.equal(typeof form.id,'number');assert.equal(form.params._meta.codex_requires_user_input,true);
  await f.bridge.receive(f.incoming('1'));
  for(let i=0;i<100&&!f.messages.some(m=>m.method==='notifications/cancelled');i++)await sleep(10);
  const cancel=f.messages.find(m=>m.method==='notifications/cancelled');assert.equal(cancel.params.requestId,form.id);
  f.send({id:form.id,result:{action:'cancel',content:null}});
  const result=(await reply).result.structuredContent;assert.equal(result.answers.choice.source,'wechat');
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
test('closing a native form leaves WeChat and the local manager available',async t=>{
  const f=await mcpFixture(t),reply=f.ask(),form=await f.waitForm(),group=f.store.pending()[0];
  f.send({id:form.id,result:{action:'cancel',content:null}});await sleep(25);assert.equal(f.store.request(group.id).status,'pending');
  f.bridge.answerLocal(group.id,{question_id:'choice',text:'从本机管理页回答'});assert.deepEqual((await reply).result.structuredContent.answers.choice.answers,['从本机管理页回答']);
});

test('real MCP /clear requests native cancellation without inventing an answer',async t=>{
  const f=await mcpFixture(t),reply=f.ask(),form=await f.waitForm(),old=f.store.pending()[0];
  await f.bridge.receive(f.incoming('/clear'));
  const result=(await reply).result.structuredContent;
  assert.equal(result.status,'cancelled');assert.deepEqual(result.answers,{});
  assert.ok(f.messages.some(m=>m.method==='notifications/cancelled'&&m.params.requestId===form.id));
  const next=f.bridge.ask({session_id:A,request_key:'after-clear',local_available:true,questions:[{id:'choice',question:'清理后新问题',options:[{label:'继续'},{label:'暂停'}]}]});assert.equal(next.questions[0].number,1);
  f.send({id:form.id,result:{action:'accept',content:{choice:'2'}}});await sleep(25);
  assert.equal(f.store.request(old.id).status,'cancelled');assert.deepEqual(f.store.request(next.id).answers,{});
});
