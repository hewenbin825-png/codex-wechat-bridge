import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DotRouter,DOT_TOOLS} from '../src/dot-router.mjs';
import {DotNativeDispatch} from '../src/dot-native.mjs';
import {DesktopHub} from '../src/desktop-hub.mjs';
import {DesktopWorker} from '../src/desktop-worker.mjs';

const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',W='44444444-4444-4444-8444-444444444444',OTHER='55555555-5555-4555-8555-555555555555';
async function fixture(t){
  let at=Date.now(),seq=0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-native-')),store=new Store(path.join(dir,'bridge.sqlite'),()=>at);
  const metadata=new Map([[A,{root:true,title:'实现主聊天',created_at:Math.floor(at/1000)-100,cwd:'implementation'}]]);
  const bridge=new Bridge({store,clock:()=>at,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>metadata.get(id)});
  bridge.creds={peer:'owner',contextToken:'fixture'};
  const hub=new DesktopHub(bridge,()=>[],()=>at);
  const dot=new DotRouter({bridge,store,clock:()=>at,vault:{load:async()=>null,save:async()=>{}},webhook:{post:async(url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})})}});
  dot.configure({enabled:true});
  await dot.subscribe({name:'owner.message.created',arguments:{},delivery:{mode:'webhook',url:'https://events.chatgpt.com/fixture',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  const register=(cap=true,id=W)=>hub.register({worker_id:id,session_id:A,verified_at:at,capabilities:{create_codex_threads:cap}});
  const request=async(text='只回复独立验收通过',action='create',target)=>{
    const messageId='native-fixture-'+(++seq);
    const prior=store.db.prepare('SELECT max(rowid) AS n FROM dot_requests').get().n||0;
    const command=action==='continue'?`/艾莉丝 继续任务 ${store.taskForSession(target)?.number||99999} ${text}`:'/新任务 '+text;
    await bridge.receive({message_id:messageId,from_user_id:'owner',message_type:1,create_time_ms:at,item_list:[{type:1,text_item:{text:command}}]});
    const row=store.db.prepare('SELECT id FROM dot_requests WHERE rowid>? ORDER BY rowid DESC LIMIT 1').get(prior);
    assert.ok(row,'The authenticated owner request must reach the dispatch inbox');
    dot.prepare({message_id:row.id,action,...(target?{session_id:target}:{})});return row.id;
  };
  const worker=(call)=>{const w=new DesktopWorker({api:async(route,body)=>hub.result(body)});w.id=W;w.client={call};return w;};
  t.after(async()=>{await dot.close();await bridge.close();store.close();});
  return {bridge,store,metadata,dot,hub,register,request,worker,advance:ms=>{at+=ms;},fresh:(id=B,root=true)=>metadata.set(id,{root,title:'独立 Codex 工作',created_at:Math.floor(at/1000),cwd:'independent'}),at:()=>at};
}

test('native Codex dispatch is opt-in, requires an upgraded verified local connector, and exposes no manual binding or shell',async t=>{
  const f=await fixture(t),id=await f.request();f.register(false);
  assert.throws(()=>f.dot.native.enqueue(id),/not enabled/);
  f.dot.configure({native_dispatch:true});assert.throws(()=>f.dot.native.enqueue(id),/not enabled/);
  assert.equal(f.register(true,OTHER).active,true);assert.equal(f.register(false,W).active,false);
  assert.equal(f.dot.native.enqueue(id).state,'queued');assert.equal(f.dot.native.enqueue(id).state,'queued');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,1);
  assert.ok(DOT_TOOLS.some(x=>x.name==='dispatch_work_chat'));
  assert.equal(DOT_TOOLS.some(x=>['bind_work_chat','exec_command'].includes(x.name)),false);
  assert.equal(DOT_TOOLS.length,5);
});

test('official local create_thread receives only the authenticated owner prompt, binds its actual result, and runs once',async t=>{
  const f=await fixture(t),ownerText='不要读写文件，只回复独立验收通过';f.dot.configure({native_dispatch:true});f.register();
  const id=await f.request(ownerText);f.dot.native.enqueue(id);const job=f.hub.poll({worker_id:W}).job;
  assert.throws(()=>f.hub.result({kind:'dot_work',worker_id:OTHER,id,state:'delivered',session_id:B}),/Unknown/);
  const calls=[];f.fresh();await f.worker(async(name,args)=>{calls.push({name,args});return {threadId:B,hostId:'local'};}).dispatch(job);
  assert.equal(calls.length,1);assert.equal(calls[0].name,'create_thread');
  assert.equal(calls[0].args.prompt,ownerText);assert.equal(calls[0].args.target.type,'projectless');
  assert.deepEqual(Object.keys(calls[0].args).sort(),['prompt','target','title']);
  assert.equal(f.dot.native.result(id).state,'bound');assert.equal(f.dot.request(id).session_id,B);
  assert.equal((await f.dot.native.wait(id,0)).task_number,1);assert.equal(f.hub.poll({worker_id:W}).job,null);
});

test('native continuation returns to the prepared known Codex chat, without creating or rerouting another chat',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});f.register();
  const first=await f.request();f.dot.native.enqueue(first);f.fresh();await f.worker(async()=>({threadId:B})).dispatch(f.hub.poll({worker_id:W}).job);
  const second=await f.request('继续整理结果','continue',B);assert.throws(()=>f.dot.prepare({message_id:second,action:'continue',session_id:A}),/explicit task action and target/);f.dot.native.enqueue(second);const calls=[];
  await f.worker(async(name,args)=>{calls.push({name,args});return {};}).dispatch(f.hub.poll({worker_id:W}).job);
  assert.deepEqual(calls,[{name:'send_message_to_thread',args:{threadId:B,hostId:'local',prompt:'继续整理结果'}}]);
  assert.equal(f.dot.native.result(second).task_number,1);assert.equal(f.store.tasks().length,1);
});

test('/clear resets Dot task numbers and cannot join an old request to a different new task with the same number',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});f.register();
  const first=await f.request();f.dot.native.enqueue(first);f.fresh();await f.worker(async()=>({threadId:B})).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.request(first).task_number,1);f.store.clearQuestions();
  assert.equal(f.dot.request(first).session_id,B);assert.equal(f.dot.request(first).task_number,null);assert.equal(f.dot.status().tasks.length,0);
  f.advance(1000);f.register();const second=await f.request('清理后的新任务');f.dot.native.enqueue(second);f.fresh(C);await f.worker(async()=>({threadId:C})).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.request(second).task_number,1);assert.deepEqual(f.dot.status().tasks.map(t=>t.session_id),[C]);
  f.store.completeTask(B,'later-turn','旧聊天新一轮');f.dot.completed(B,'later-turn','后续结果');
  assert.equal(f.dot.request(first).task_number,2);assert.equal(f.dot.request(second).task_number,1);
});

test('delayed local session indexing retries binding only, while child or old chats are never accepted',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});f.register();
  const id=await f.request();f.dot.native.enqueue(id);let calls=0;
  await f.worker(async()=>{calls++;return {threadId:B};}).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.native.result(id).state,'awaiting_binding');f.fresh();f.dot.native.sweep();
  assert.equal(f.dot.native.result(id).state,'bound');assert.equal(calls,1);
  const child=await f.request();f.dot.native.enqueue(child);f.fresh(C,false);
  await f.worker(async()=>({threadId:C})).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.native.result(child).state,'uncertain');assert.equal(f.store.tasks().length,1);
  const old=await f.request();f.dot.native.enqueue(old);await f.worker(async()=>({threadId:A})).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.native.result(old).state,'uncertain');assert.equal(f.store.tasks().length,1);
});

test('native creation timeouts, pending client IDs and process restarts stay uncertain and are never replayed',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});f.register();
  const first=await f.request();f.dot.native.enqueue(first);let calls=0;
  await f.worker(async()=>{calls++;throw Object.assign(new Error('lost acknowledgement'),{code:'DESKTOP_TIMEOUT'});}).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.native.enqueue(first).state,'uncertain');assert.equal(f.hub.poll({worker_id:W}).job,null);assert.equal(calls,1);
  const pending=await f.request();f.dot.native.enqueue(pending);await f.worker(async()=>({clientThreadId:B})).dispatch(f.hub.poll({worker_id:W}).job);
  assert.equal(f.dot.native.result(pending).state,'uncertain');
  const crash=await f.request();f.dot.native.enqueue(crash);f.hub.poll({worker_id:W});
  f.dot.native=new DotNativeDispatch(f.dot);assert.equal(f.dot.native.result(crash).state,'uncertain');assert.equal(f.hub.poll({worker_id:W}).job,null);
});

test('queued native work expires or is cancelled on revocation; another WeChat owner cannot inspect or execute it',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});f.register();
  const expired=await f.request();f.dot.native.enqueue(expired);f.advance(121000);f.register();assert.equal(f.hub.poll({worker_id:W}).job,null);assert.equal(f.dot.native.result(expired).state,'failed');
  f.register();const cancelled=await f.request();f.dot.native.enqueue(cancelled);f.dot.configure({native_dispatch:false});assert.equal(f.dot.native.result(cancelled).state,'cancelled');
  f.bridge.creds.peer='another-owner';assert.equal(f.dot.native.ready(),false);assert.throws(()=>f.dot.native.result(cancelled),/Unknown owner/);
});

test('a brief verified desktop reconnection is tolerated inside the call and creates only one job',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});const id=await f.request();
  const waiting=f.dot.native.wait(id,400);
  assert.equal(f.dot.native.row(id),undefined,'No work is queued before the desktop is connected');
  const recovery=setTimeout(()=>f.register(),40);t.after(()=>clearTimeout(recovery));
  const result=await waiting;
  assert.equal(result.state,'queued');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,1);
  assert.equal((await f.dot.native.wait(id,0)).state,'queued');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,1);
});

test('unavailable or disabled native dispatch never leaves a job that starts after the failed call',async t=>{
  const f=await fixture(t);f.dot.configure({native_dispatch:true});const id=await f.request();
  await assert.rejects(()=>f.dot.native.wait(id,35),/not enabled and connected/);
  f.register();assert.equal(f.dot.native.row(id),undefined);assert.equal(f.hub.poll({worker_id:W}).job,null);
  f.dot.configure({native_dispatch:false});
  await assert.rejects(()=>f.dot.native.wait(id,35),/not enabled and connected/);
  f.dot.configure({native_dispatch:true});assert.equal(f.hub.poll({worker_id:W}).job,null);
});
