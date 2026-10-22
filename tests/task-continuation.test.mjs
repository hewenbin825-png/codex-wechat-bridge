import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { DesktopHub } from '../src/desktop-hub.mjs';
import { DesktopWorker, CompletionMonitor } from '../src/desktop-worker.mjs';
import { AppClient } from '../src/app-client.mjs';
import { continuationCommand } from '../src/tasks.mjs';
import { isRootSession } from '../src/sessions.mjs';
import { handleHook } from '../src/hook.mjs';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', CHILD = '33333333-3333-4333-8333-333333333333';
function fixture(t, clock = Date.now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-tasks-'));
  const store = new Store(path.join(dir,'bridge.sqlite'),clock);
  const metadata = new Map([[A,{root:true,title:'文章发布',cwd:'test-A'}],[B,{root:true,title:'硬件诊断',cwd:'test-B'}],[CHILD,{root:false,title:'子智能体'}]]);
  const bridge = new Bridge({store,clock,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>metadata.get(id)});
  bridge.creds = {peer:'owner',contextToken:'dummy-not-a-secret'};
  const hub = new DesktopHub(bridge,()=>[...metadata].filter(([,v])=>v.root).map(([id])=>({id})),clock);
  const worker = '44444444-4444-4444-8444-444444444444';
  const notify = (session=A,turn='turn-1') => bridge.notify({type:'agent-turn-complete','thread-id':session,'turn-id':turn,'last-assistant-message':'本轮结果，发布仍待浏览器恢复。'});
  let seq = 0;
  const incoming = (text, extra={}) => ({message_id:String(++seq),from_user_id:'owner',message_type:1,create_time_ms:clock(),item_list:[{type:1,text_item:{text}}],...extra});
  const receipts = () => store.db.prepare("SELECT text FROM outbox WHERE kind='receipt' ORDER BY rowid").all().map(r=>r.text);
  t.after(async()=>{await bridge.close();store.close();});
  return {dir,store,bridge,hub,worker,notify,incoming,receipts,metadata};
}

test('root classification excludes every subagent source, role and parent; unknown sources fail closed', () => {
  for (const source of ['cli','vscode','exec','appServer']) assert.equal(isRootSession({source}),true);
  for (const source of ['unknown','subagent','{"subAgent":{"thread_spawn":{}}}',{subAgent:'review'},'{bad-json']) assert.equal(isRootSession({source}),false);
  for (const field of ['agent_role','agent_path','parentThreadId','parent_thread_id']) assert.equal(isRootSession({source:'vscode',[field]:'child'}),false);
  assert.equal(isRootSession(null),false);
});

test('only root completions allocate stable task numbers, with hook/monitor dedup and restart persistence', async t => {
  const f=fixture(t);
  assert.equal(f.notify(CHILD).suppressed,'not_main_task');
  assert.equal(f.notify('unknown').suppressed,'not_main_task');
  assert.equal(f.store.tasks().length,0);
  f.notify(); f.notify(B); f.notify();
  assert.deepEqual(f.store.tasks().map(t=>[t.number,t.session_id]),[[1,A],[2,B]]);
  const secondStore = new Store(path.join(f.dir,'bridge.sqlite'));
  assert.equal(secondStore.completeTask(A,'turn-1','duplicate').duplicate,true);
  assert.equal(secondStore.tasks()[0].title,'文章发布'); secondStore.close();
  f.notify(A,'turn-2');
  assert.equal(f.store.tasks()[0].number,1);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='completion'").get().n,3);
  const text = f.store.db.prepare("SELECT text FROM outbox WHERE kind='completion' ORDER BY rowid LIMIT 1").get().text;
  assert.ok(text.includes('/1 继续任务')); assert.ok(text.includes('本轮结束')); assert.ok(!text.includes('任务 1 已完成'));
});

test('slash parser separates question answers, requires a task in concurrent completions and preserves prompt text', () => {
  const tasks=[{number:1,state:'completed',title:'A'},{number:2,state:'completed',title:'B'}];
  assert.equal(continuationCommand('1.1',tasks),null);
  assert.equal(continuationCommand('先整理原因',tasks),null);
  assert.ok(continuationCommand('/继续任务',tasks).error.includes('多个任务'));
  assert.equal(continuationCommand('（/2 按这个改\n保留现场）',tasks).prompt,'按这个改\n保留现场');
  assert.equal(continuationCommand('/继续任务',tasks.slice(0,1)).task.number,1);
  assert.equal(continuationCommand('/先整理原因',tasks.slice(0,1)).prompt,'先整理原因');
  for (const text of ['/99 继续','/1','/','/1 '+ '字'.repeat(8001)]) assert.ok(continuationCommand(text,tasks).error);
});

test('unavailable desktop never claims submission; slash messages cannot answer pending questions', async t => {
  const f=fixture(t); f.notify();
  const request = f.bridge.ask({request_key:'pending',session_id:A,questions:[{id:'choice',question:'格式？',options:['Word','PDF']}]});
  await f.bridge.receive(f.incoming('/继续任务'));
  assert.ok(f.receipts().at(-1).includes('尚未提交'));
  assert.equal(f.store.request(request.id).status,'pending');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
  await f.bridge.receive(f.incoming('2'));
  assert.equal(f.store.request(request.id).answers.choice.answers[0],'PDF');
});

test('authenticated numbered prompts route once to the mapped original root; ordinary and ambiguous text cannot dispatch', async t => {
  const f=fixture(t); f.notify(); f.notify(B);
  f.hub.register({worker_id:f.worker,session_id:A});
  await f.bridge.receive(f.incoming('/继续任务'));
  assert.ok(f.receipts().at(-1).includes('多个任务'));
  const message=f.incoming('/2 先汇总诊断结果，不启动硬件');
  await f.bridge.receive({...message,from_user_id:'intruder'});
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM continuations').get().n,0);
  await f.bridge.receive(message); await f.bridge.receive(message);
  const job=f.hub.poll({worker_id:f.worker}).job;
  assert.equal(job.session_id,B); assert.equal(job.prompt,'先汇总诊断结果，不启动硬件');
  assert.equal(f.hub.poll({worker_id:f.worker}).job,null);
  assert.throws(()=>f.hub.result({worker_id:'wrong',id:job.id,state:'delivered'}));
  f.hub.result({worker_id:f.worker,id:job.id,state:'delivered'});
  assert.equal(f.store.task(2).state,'active');
  assert.equal(f.store.continuation(job.id).prompt,'');
  assert.ok(f.receipts().at(-1).includes('原聊天'));
  f.notify(B,'turn-2'); assert.equal(f.store.task(2).state,'completed');
  f.notify(B,'turn-1'); assert.equal(f.store.task(2).last_turn,'turn-2');
});

test('worker delivery uses the native message tool without model or permission overrides', async t => {
  const f=fixture(t); f.notify(); f.hub.register({worker_id:f.worker,session_id:A});
  await f.bridge.receive(f.incoming('/1 继续任务'));
  const job=f.hub.poll({worker_id:f.worker}).job, calls=[];
  const worker=new DesktopWorker({api:async(route,body)=>f.hub.result(body)});
  worker.id=f.worker; worker.client={call:async(name,args)=>calls.push({name,args})};
  await worker.dispatch(job);
  assert.deepEqual(calls,[{name:'send_message_to_thread',args:{threadId:A,hostId:'local',prompt:'继续任务'}}]);
  assert.equal(f.store.continuation(job.id).state,'delivered');
});

test('stale prompts cannot resume a newer completion and stale native health cannot renew desktop readiness', async t => {
  let at=1000000; const f=fixture(t,()=>at); f.notify();
  f.hub.register({worker_id:f.worker,session_id:A,verified_at:at});
  await f.bridge.receive(f.incoming('/1 旧要求',{create_time_ms:at-10000}));
  assert.ok(f.receipts().at(-1).includes('早于')); assert.equal(f.store.claimContinuation(f.worker),null);
  at+=15000; f.hub.register({worker_id:f.worker,session_id:A,verified_at:at-15000});
  at+=6000; assert.equal(f.hub.ready(),false);
  assert.equal(f.hub.register({worker_id:f.worker,session_id:A,verified_at:at-21000}).active,false);
});

test('dispatch timeout or crash is uncertain and never automatically replayed; queued jobs expire', async t => {
  let at=1000000; const f=fixture(t,()=>at); f.notify();
  f.hub.register({worker_id:f.worker,session_id:A}); await f.bridge.receive(f.incoming('/1 下一步'));
  const job=f.hub.poll({worker_id:f.worker}).job;
  const worker=new DesktopWorker({api:async(route,body)=>f.hub.result(body)});
  worker.id=f.worker; worker.client={call:async()=>{throw Object.assign(new Error('lost acknowledgement'),{code:'DESKTOP_TIMEOUT'});}};
  await worker.dispatch(job);
  assert.equal(f.store.task(1).state,'uncertain'); assert.equal(f.store.claimContinuation(f.worker),null);
  f.notify(A,'next'); f.hub.register({worker_id:f.worker,session_id:A}); await f.bridge.receive(f.incoming('/1 再整理'));
  const crash=f.hub.poll({worker_id:f.worker}).job;
  const restarted=new Store(path.join(f.dir,'bridge.sqlite'),()=>at);
  assert.equal(restarted.continuation(crash.id).state,'uncertain'); assert.equal(restarted.claimContinuation('other'),null); restarted.close();
  f.notify(A,'third'); f.hub.register({worker_id:f.worker,session_id:A}); await f.bridge.receive(f.incoming('/1 等连接'));
  at+=121000; f.hub.sweep();
  assert.equal(f.store.task(1).state,'completed'); assert.equal(f.store.claimContinuation(f.worker),null);
});

test('archived roots are excluded from shorthand and subagent Stop produces no spool file', async t => {
  const f=fixture(t); f.notify(); f.notify(B); f.metadata.get(B).archived=1;
  f.hub.register({worker_id:f.worker,session_id:A});
  await f.bridge.receive(f.incoming('/继续任务'));
  assert.equal(f.hub.poll({worker_id:f.worker}).job.session_id,A);
  await handleHook({hook_event_name:'Stop',session_id:A,agent_id:'child',last_assistant_message:'child finished'},{state:f.dir});
  assert.equal(fs.existsSync(path.join(f.dir,'spool')),false);
});

test('desktop monitor suppresses startup history and remote/child tasks, then reports only a root final', async () => {
  let active=true, stamp=1; const reads=[],emitted=[];
  const api={call:async(name,args)=>{
    if(name==='list_threads') return {threads:[{id:A,kind:'codex',hostId:'local',status:active?'active':'idle',updatedAt:stamp},{id:B,kind:'codex',hostId:'local',status:'idle',updatedAt:1},{id:CHILD,kind:'codex',hostId:'local',status:'idle',updatedAt:stamp}]};
    reads.push(args.threadId); return {turns:[{id:'final-turn',status:'completed',items:[{type:'agentMessage',phase:'commentary',text:'working'},{type:'agentMessage',phase:'final',text:'本轮结果'}]}]};
  }};
  const monitor=new CompletionMonitor(api,async(route,event)=>emitted.push(event));
  await monitor.scan([A,B]); assert.equal(reads.length,0);
  active=false; stamp=2; await monitor.scan([A,B]); await monitor.scan([A,B]);
  assert.deepEqual(reads,[A]); assert.equal(emitted.length,1); assert.equal(emitted[0].payload['last-assistant-message'],'本轮结果');
});

test('App Tools adapter speaks stdio MCP, passes its actual caller, and blocks all tools outside the allowlist', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-app-fixture-'));
  const server=path.join(dir,'fixture.mjs');
  fs.writeFileSync(server,`import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
    const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
    m.method==='tools/list'?{tools:['list_threads','read_thread','send_message_to_thread'].map(name=>({name,inputSchema:{type:'object'}}))}:
    {content:[{type:'text',text:JSON.stringify(m.params)}]};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const client=new AppClient(A,{server,env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:'FIXTURE-NO-REAL-PIPE'}});
  t.after(()=>client.close()); await client.start();
  const result=await client.call('read_thread',{threadId:B},'real-test-turn');
  assert.equal(result._meta['x-codex-turn-metadata'].thread_id,A);
  assert.equal(result.arguments.threadId,B);
  await assert.rejects(client.call('exec_command',{cmd:'anything'}));
});
