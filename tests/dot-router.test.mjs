import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {Store} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DotRouter} from '../src/dot-router.mjs';
import {publicAddress,callbackUrl,signedHeaders,WebhookClient,resolveCallbackAddresses} from '../src/dot-webhook.mjs';
import {serve} from '../src/service.mjs';
import {ROOT} from '../src/common.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',CHILD='33333333-3333-4333-8333-333333333333';
const secret='whsec_'+Buffer.alloc(32,7).toString('base64');
function fixture(t,managed=true){
  let now=Date.now(),vaultData=null,seq=0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dot-')),store=new Store(path.join(dir,'bridge.sqlite'),()=>now);
  for(const id of [A,B])store.setChatMode(id,'wechat');
  const metadata=new Map([[A,{root:true,title:'独立任务 A',created_at:Math.floor(now/1000),cwd:'test-A'}],[B,{root:true,title:'独立任务 B',created_at:Math.floor(now/1000),cwd:'test-B'}],[CHILD,{root:false,title:'子智能体'}]]);
  const bridge=new Bridge({store,clock:()=>now,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>metadata.get(id)});
  bridge.creds={peer:'owner',contextToken:'not-a-secret'};
  const vault={load:async()=>vaultData,save:async value=>{vaultData=structuredClone(value);}},sent=[];
  let outcome=200;
  const webhook={post:async(url,body,headers)=>{sent.push({url,body,headers});const payload=JSON.parse(body);return {status:outcome,body:JSON.stringify({challenge:payload.challenge})};}};
  const dot=new DotRouter({bridge,store,vault,webhook,clock:()=>now});
  const incoming=(text,extra={})=>({message_id:String(++seq),from_user_id:'owner',message_type:1,create_time_ms:now,item_list:[{type:1,text_item:{text}}],...extra});
  const subscribe=(name='owner.message.created',extra={})=>dot.subscribe({name,arguments:{},delivery:{mode:'webhook',url:'https://events.chatgpt.com/mcp/test-owner',secret},...extra});
  if(managed)t.after(async()=>{await dot.close();await bridge.close();store.close();});
  return {dir,store,bridge,dot,vault,webhook,sent,incoming,subscribe,metadata,advance:ms=>{now+=ms;},setOutcome:n=>{outcome=n;}};
}

test('Dot is opt-in; unavailable/new commands do not fall into an unrelated continuation or capture question answers',async t=>{
  const f=fixture(t);
  const pending=f.bridge.ask({presentation:'chat_text',session_id:A,request_key:'own',questions:[{id:'q',question:'怎么选',options:[{label:'一'},{label:'二'}]}]});
  await f.bridge.receive(f.incoming('/艾莉丝 帮我写程序'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,0);
  assert.equal(f.store.request(pending.id).status,'pending');
  f.dot.configure({enabled:true});await f.subscribe();
  await f.bridge.receive(f.incoming('2'));
  assert.equal(f.store.request(pending.id).answers.q.answers[0],'二');
  await f.bridge.receive(f.incoming('/艾莉丝 单独研究一个新问题'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,1);
  assert.equal(f.store.tasks().length,0);
  await f.bridge.receive(f.incoming('/艾莉丝 外人的请求',{from_user_id:'other'}));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,1);
});

test('subscription requires verified OpenAI callback, persists and renews without duplicate delivery; disable and owner rebind stop it',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});
  await assert.rejects(()=>f.subscribe('owner.message.created',{delivery:{mode:'webhook',url:'https://example.com/collect',secret}}));
  const a=await f.subscribe(),b=await f.subscribe();assert.equal(a.id,b.id);assert.equal(f.dot.status().subscription_count,1);
  assert.equal(f.store.db.prepare('SELECT * FROM dot_subscriptions').get().secret,undefined);
  const restored=await new DotRouter({bridge:f.bridge,vault:f.vault,webhook:f.webhook,clock:f.dot.clock}).init();assert.equal(restored.ready(),true);
  f.dot.configure({enabled:false});assert.equal(restored.ready(),false);
  f.dot.configure({enabled:true});await f.subscribe();f.bridge.creds.peer='another-owner';assert.equal(f.dot.ready(),false);
});

test('one owner event grants native creation only once, binds a real fresh root and cannot change or reuse a work chat',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();
  const inbound=f.incoming('/新任务 新建测试工作');await f.bridge.receive(inbound);await f.bridge.receive(inbound);
  const msg=f.store.db.prepare('SELECT id FROM dot_requests').get().id;
  assert.equal(f.dot.prepare({message_id:msg,action:'create'}).claimed_now,true);
  assert.equal(f.dot.prepare({message_id:msg,action:'create'}).claimed_now,false);
  assert.throws(()=>f.dot.bind({message_id:msg,session_id:CHILD}));
  const a=f.dot.bind({message_id:msg,session_id:A});assert.equal(a.number,1);
  assert.equal(f.dot.bind({message_id:msg,session_id:A}).duplicate,true);
  assert.throws(()=>f.dot.bind({message_id:msg,session_id:B}));
  await f.bridge.receive(f.incoming('/新任务 另一个独立工作'));const second=f.store.db.prepare('SELECT id FROM dot_requests WHERE id<>?').get(msg).id;
  f.dot.prepare({message_id:second,action:'create'});assert.throws(()=>f.dot.bind({message_id:second,session_id:A}));
  f.metadata.get(B).created_at-=60;assert.throws(()=>f.dot.bind({message_id:second,session_id:B}));
  f.metadata.get(B).created_at+=60;assert.equal(f.dot.bind({message_id:second,session_id:B}).number,2);
});

test('related work can continue only the explicitly prepared managed chat; main completion still goes through one gateway and children stay silent',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();await f.subscribe('task.completed');
  await f.bridge.receive(f.incoming('/新任务 新建'));const id=f.store.db.prepare('SELECT id FROM dot_requests').get().id;
  f.dot.prepare({message_id:id,action:'create'});f.dot.bind({message_id:id,session_id:A});
  await f.bridge.receive(f.incoming('/艾莉丝 继续任务 1 继续这个工作'));const next=f.store.db.prepare('SELECT id FROM dot_requests WHERE id<>?').get(id).id;
  assert.throws(()=>f.dot.prepare({message_id:next,action:'continue',session_id:B}));
  f.dot.prepare({message_id:next,action:'continue',session_id:A});assert.throws(()=>f.dot.bind({message_id:next,session_id:B}));f.dot.bind({message_id:next,session_id:A});
  const payload={type:'agent-turn-complete','thread-id':A,'turn-id':'same-turn','last-assistant-message':'完成'};
  f.bridge.notify(payload);f.bridge.notify(payload);f.bridge.notify({...payload,'thread-id':CHILD});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n,1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM dot_deliveries WHERE body LIKE '%task.completed%'").get().n,1);
  assert.equal(f.store.tasks().length,1);
});

test('webhook uses stable event IDs, fresh signatures and bounded retry; HTTP 410 ends subscription and receipts cannot loop',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();await f.bridge.receive(f.incoming('/dot 新事件'));
  f.setOutcome(503);await f.dot.tick();const first=JSON.parse(f.sent.at(-1).body);
  f.advance(10000);f.setOutcome(200);await f.dot.tick();const last=JSON.parse(f.sent.at(-1).body);
  assert.equal(first.eventId,last.eventId);assert.notEqual(f.sent.at(-2).headers['webhook-signature'],f.sent.at(-1).headers['webhook-signature']);
  assert.equal(f.store.db.prepare('SELECT state FROM dot_deliveries').get().state,'delivered');
  await f.bridge.receive(f.incoming('/dot 又一事件'));f.setOutcome(410);await f.dot.tick();assert.equal(f.dot.ready(),false);
  await f.bridge.receive(f.incoming('/dot 出站回执',{message_type:2}));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,2);
});

test('callback validation blocks local, private, mapped and documentation addresses; signing matches independent HMAC',async()=>{
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.1.1','172.16.1.1','192.168.0.1','100.64.0.1','198.18.0.1','192.0.2.1','203.0.113.4','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:808:808::1'])assert.equal(publicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
  for(const url of ['http://events.chatgpt.com/','https://events.chatgpt.com.evil.com/','https://user:secret@events.chatgpt.com/','https://127.0.0.1/','https://events.chatgpt.com:444/'])assert.throws(()=>callbackUrl(url));
  const client=new WebhookClient({lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{throw new Error('Must not connect');}});await assert.rejects(()=>client.post('https://events.chatgpt.com/','{}',{}),/not public/);
  const headers=signedHeaders(secret,'evt-test','{}',1000,'sub-test');assert.equal(headers['webhook-signature'],'v1,'+crypto.createHmac('sha256',Buffer.alloc(32,7)).update('evt-test.1.{}').digest('base64'));
});

test('RPC exposes only curated dispatch tools and request text, and worker status is scoped to its original chat',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();
  f.bridge.ask({presentation:'chat_text',session_id:A,request_key:'a',questions:[{id:'a',question:'A 的问题'}]});f.bridge.ask({presentation:'chat_text',session_id:B,request_key:'b',questions:[{id:'b',question:'B 的问题'}]});
  assert.equal(f.bridge.status(A).pending.length,1);assert.equal(f.bridge.status(A).pending[0].questions[0].question,'A 的问题');
  const discovered=await f.dot.rpc({jsonrpc:'2.0',id:1,method:'server/discover'});assert.deepEqual(discovered.result.supportedVersions,['2026-07-28']);
  const status=await f.dot.rpc({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'dot_bridge_status',arguments:{}}});assert.equal(JSON.stringify(status).includes('A 的问题'),false);
  const unknown=await f.dot.rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'exec_command',arguments:{}}});assert.ok(unknown.error);
  const invalid=await f.dot.rpc(null);assert.ok(invalid.error);
});

test('actual Dot stdio target discovers events through authenticated local HTTP without exposing bridge credentials',async t=>{
  const f=fixture(t,false),app=await serve({state:f.dir,port:0,bridge:f.bridge,listen:false,dotVault:f.vault,dotWebhook:f.webhook});
  const child=spawn(process.execPath,[path.join(ROOT,'src','dot-mcp.mjs')],{env:{...process.env,CODEX_WECHAT_STATE:f.dir},windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const lines=readline.createInterface({input:child.stdout});t.after(async()=>{lines.close();child.kill();await app.close();});
  const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Dot stdio timeout')),5000);lines.once('line',line=>{clearTimeout(timer);resolve(JSON.parse(line));});});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:11,method:'events/list'})+'\n');const out=await response;
  assert.equal(out.id,11);assert.equal(out.result.events.length,2);assert.equal(JSON.stringify(out).includes(fs.readFileSync(path.join(f.dir,'control.token'),'utf8')),false);
});

test('callback key rotation overlaps signatures; replacing the coordinator and revoking during verification stop old subscriptions',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();
  const rotated='whsec_'+Buffer.alloc(32,9).toString('base64');
  await f.subscribe('owner.message.created',{delivery:{mode:'webhook',url:'https://events.chatgpt.com/mcp/test-owner',secret:rotated}});
  await f.bridge.receive(f.incoming('/dot 轮换后的消息'));await f.dot.tick();assert.equal(f.sent.at(-1).headers['webhook-signature'].split(' ').length,2);
  await f.subscribe('owner.message.created',{delivery:{mode:'webhook',url:'https://events.chatgpt.com/mcp/replacement',secret:rotated}});assert.equal(f.dot.status().subscription_count,1);
  let finish;f.dot.webhook={post:async(url,body)=>new Promise(resolve=>{finish=()=>resolve({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})});})};
  const pending=f.subscribe();f.dot.configure({enabled:false});finish();await assert.rejects(()=>pending,/changed/);assert.equal(f.dot.ready(),false);
});

test('a fast task completion before binding still reaches Dot once; a Dot failure cannot suppress the main WeChat completion',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});await f.subscribe();await f.subscribe('task.completed');
  await f.bridge.receive(f.incoming('/新任务 很快完成的工作'));const id=f.store.db.prepare('SELECT id FROM dot_requests').get().id;f.dot.prepare({message_id:id,action:'create'});
  f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'fast','last-assistant-message':'结果'});f.dot.bind({message_id:id,session_id:A});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM dot_deliveries WHERE body LIKE '%task.completed%'").get().n,1);
  f.bridge.dot.completed=()=>{throw new Error('Simulated isolated Dot failure');};
  f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'next','last-assistant-message':'后续结果'});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n,2);
});

test('real worker MCP neither reveals another chat’s pending questions nor accepts a spoofed question destination',async t=>{
  const f=fixture(t,false),app=await serve({state:f.dir,port:0,bridge:f.bridge,listen:false,dotVault:f.vault,dotWebhook:f.webhook});
  const a=f.bridge.ask({presentation:'chat_text',session_id:A,request_key:'a',questions:[{id:'a',question:'A 私有问题'}]}),b=f.bridge.ask({presentation:'chat_text',session_id:B,request_key:'b',questions:[{id:'b',question:'B 私有问题'}]});
  const env={...process.env,CODEX_WECHAT_STATE:f.dir,CODEX_THREAD_ID:A};delete env.CODEX_APP_TOOLS_PIPE_PATH;
  const child=spawn(process.execPath,[path.join(ROOT,'src','mcp.mjs')],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});child.stderr.resume();
  const lines=readline.createInterface({input:child.stdout}),pending=new Map();let id=0;
  lines.on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);});
  const rpc=(name,args)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(new Error('Worker MCP timeout')),5000);pending.set(key,r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method:'tools/call',params:{name,arguments:args}})+'\n');});
  t.after(async()=>{lines.close();child.kill();await app.close();});
  const status=(await rpc('get_status',{})).result.structuredContent;assert.equal(status.context_scope,'current_chat');assert.equal(status.pending.length,1);assert.equal(status.pending[0].id,a.id);assert.equal(JSON.stringify(status).includes('B 私有问题'),false);
  assert.equal((await rpc('check_answer',{request_id:b.id})).result.isError,true);
  assert.equal((await rpc('ask_user',{session_id:B,questions:[{id:'bad',question:'误投'}]})).result.isError,true);
  assert.equal(f.store.pending().length,2);
});

test('new Dot work remains native and silent, including completion before binding; direct conversation still replies',async t=>{
  const f=fixture(t);f.store.setChatMode(A,'native');f.dot.configure({enabled:true});await f.subscribe();await f.subscribe('task.completed');
  await f.bridge.receive(f.incoming('/新任务 默认不通知的任务'));
  const row=f.store.db.prepare("SELECT * FROM dot_requests WHERE intent='task'").get();f.dot.prepare({message_id:row.id,action:'create'});
  assert.equal(f.dot.reply({message_id:row.id,update_key:'progress',text:'开始工作'}).suppressed,'chat_mode_native');
  f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'fast-native','last-assistant-message':'不发到微信的结果'});
  assert.equal(f.store.tasks().length,0);
  f.dot.bind({message_id:row.id,session_id:A});assert.equal(f.store.taskForSession(A).state,'completed');assert.equal(f.store.chatMode(A),'native');
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE event_key LIKE 'dot-bound:%' OR event_key LIKE 'dot-reply:%' OR kind='completion'").get().n,0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM dot_deliveries WHERE body LIKE '%task.completed%'").get().n,0);
  await f.bridge.receive(f.incoming('/艾莉丝 对话 你好'));
  const chat=f.store.db.prepare("SELECT * FROM dot_requests WHERE intent='conversation'").get();f.dot.reply({message_id:chat.id,update_key:'one',text:'你好'});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE event_key LIKE 'dot-chat-reply:%'").get().n,1);
  f.store.setChatMode(A,'wechat');f.bridge.notify({type:'agent-turn-complete','thread-id':A,'turn-id':'explicit','last-assistant-message':'明确开启后通知'});
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n,1);
});

test('live subscription diagnostics record only known method names and outcomes, never secrets or callback paths',async t=>{
  const f=fixture(t);f.dot.configure({enabled:true});
  const marker='private-query-and-body-marker';
  const failed=await f.dot.rpc({jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'owner.message.created',delivery:{mode:'webhook',url:'https://example.com/'+marker,secret},arguments:{marker}}});
  assert.ok(failed.error);
  const succeeded=await f.dot.rpc({jsonrpc:'2.0',id:2,method:'events/subscribe',params:{name:'owner.message.created',arguments:{},delivery:{mode:'webhook',url:'https://events.chatgpt.com/'+marker,secret}}});
  assert.ok(succeeded.result.id);
  const recorded=f.store.db.prepare("SELECT details FROM events WHERE event LIKE 'dot_rpc_%'").all();
  const text=JSON.stringify(recorded);
  assert.equal(text.includes(marker),false);assert.equal(text.includes(secret),false);
  assert.equal(text.includes('https://'),false);assert.equal(recorded.length,4);
});

test('Fake-IP DNS is replaced only with validated public OpenAI addresses; private and mixed answers stay blocked',async()=>{
  const host='connectors.api.openai.com',publicAnswers=[{address:'104.18.38.184',family:4}];let called=0;
  const doh=async name=>{called++;assert.equal(name,host);return publicAnswers;};
  assert.deepEqual(await resolveCallbackAddresses(host,{lookup:async()=>publicAnswers,doh}),publicAnswers);assert.equal(called,0);
  assert.deepEqual(await resolveCallbackAddresses(host,{lookup:async()=>[{address:'198.18.0.254',family:4}],doh}),publicAnswers);assert.equal(called,1);
  await assert.rejects(()=>resolveCallbackAddresses(host,{lookup:async()=>[{address:'127.0.0.1',family:4}],doh}),/not public/);assert.equal(called,1);
  await assert.rejects(()=>resolveCallbackAddresses(host,{lookup:async()=>[{address:'198.18.0.254',family:4}],doh:async()=>[...publicAnswers,{address:'10.0.0.1',family:4}]}),/not public/);
  await assert.rejects(()=>resolveCallbackAddresses('untrusted.example',{lookup:()=>{throw new Error('Must not query');},doh}),/OpenAI/);assert.equal(called,1);
});
