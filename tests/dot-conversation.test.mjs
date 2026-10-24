import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {Bridge} from '../src/bridge.mjs';
import {DotRouter} from '../src/dot-router.mjs';
import {hash} from '../src/common.mjs';

const A='11111111-1111-4111-8111-111111111111',W='44444444-4444-4444-8444-444444444444';
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-chat-')),store=new Store(path.join(dir,'bridge.sqlite'));
  store.setChatMode(A,'wechat');
  const bridge=new Bridge({store,api:{send:async()=>{}},vault:{save:async()=>{}},sessionLookup:id=>id===A?{root:true,archived:false,title:'原工作聊天',created_at:Math.floor(Date.now()/1000)}:null});
  bridge.creds={peer:'owner',contextToken:'fixture'};bridge.desktop={ready:()=>true,canCreateCodex:()=>true};
  let seq=0;
  const options={bridge,store,vault:{load:async()=>null,save:async()=>{}},webhook:{post:async(url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})})}};
  const dot=new DotRouter(options);dot.configure({enabled:true,native_dispatch:true});
  await dot.subscribe({name:'owner.message.created',arguments:{},delivery:{mode:'webhook',url:'https://events.chatgpt.com/test',secret:'whsec_'+Buffer.alloc(32,7).toString('base64')}});
  const incoming=(text,extra={})=>({message_id:String(++seq),from_user_id:'owner',message_type:1,create_time_ms:Date.now(),item_list:[{type:1,text_item:{text}}],...extra});
  const send=text=>bridge.receive(incoming(text));
  const last=()=>store.db.prepare('SELECT * FROM dot_requests ORDER BY rowid DESC LIMIT 1').get();
  const rpc=async(name,args)=>(await dot.rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}));
  t.after(async()=>{await dot.close();await bridge.close();store.close();});
  return {dir,store,bridge,dot,options,incoming,send,last,rpc};
}

test('continuous dialogue returns real replies without granting a native work claim or allocating task numbers',async t=>{
  const f=await fixture(t);await f.send('/艾莉丝 对话');assert.equal(f.dot.dialogueActive(),true);assert.equal(f.last(),undefined);
  await f.send('你好，今天先聊一下方案');const row=f.last();assert.equal(row.intent,'conversation');assert.equal(row.text,'你好，今天先聊一下方案');
  const read=(await f.rpc('read_dispatch_request',{message_id:row.id})).result.structuredContent;
  assert.equal(read.intent,'conversation');assert.equal(read.native_dispatch.state,'conversation_only');
  assert.throws(()=>f.dot.prepare({message_id:row.id,action:'create'}),/Conversation/);
  await assert.rejects(()=>f.dot.native.wait(row.id,0),/Conversation/);assert.throws(()=>f.dot.bind({message_id:row.id,session_id:A}));
  await f.rpc('reply_to_owner',{message_id:row.id,update_key:'reply',text:'我们可以先讨论，再由你决定是否创建任务。'});
  assert.equal(f.dot.request(row.id).state,'replied');assert.equal(f.dot.status().pending_conversations,0);
  assert.equal(f.store.db.prepare("SELECT text FROM outbox WHERE event_key=?").get('dot-chat-reply:'+row.id).text,'【艾莉丝】\n我们可以先讨论，再由你决定是否创建任务。');
  assert.equal(f.store.tasks().length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,0);
});

test('explicit task commands alone grant the recorded action, with the exact owner work prompt',async t=>{
  const f=await fixture(t);await f.send('/艾莉丝 对话 创建任务 只是讨论这几个字');assert.equal(f.last().intent,'conversation');
  await f.send('/艾莉丝 不要创建任务，先告诉我怎么做');assert.equal(f.last().intent,'conversation');
  await f.send('/艾莉丝 创建任务：只回复独立任务通过');const row=f.last();assert.equal(row.intent,'task');assert.equal(row.text,'只回复独立任务通过');
  assert.throws(()=>f.dot.prepare({message_id:row.id,action:'continue',session_id:A}),/explicit task action and target/);
  assert.equal(f.dot.prepare({message_id:row.id,action:'create'}).claimed_now,true);f.dot.native.enqueue(row.id);
  const job=f.dot.native.claim(W);assert.equal(job.prompt,'只回复独立任务通过');assert.equal(job.action,'create');
  assert.equal(f.dot.native.claim(W),null);assert.equal(f.store.tasks().length,0);
});

test('pending question answers, numbered supplements, slash continuations and clear retain their original routes during dialogue',async t=>{
  const f=await fixture(t);await f.send('/艾莉丝 对话');const q=f.bridge.ask({presentation:'chat_text',session_id:A,request_key:'question',questions:[{id:'q',question:'请选择',options:[{label:'原聊天选项'},{label:'另一个选项'}]}]});
  await f.send('1');assert.equal(f.store.request(q.id).answers.q.answers[0],'原聊天选项');assert.equal(f.last(),undefined);
  const number=f.store.request(q.id).questions[0].number;await f.send(number+'.补充原工作');assert.equal(f.last(),undefined);
  assert.equal(f.store.db.prepare("SELECT prompt FROM continuations WHERE kind='continuation'").get().prompt,`【第${number}题的后续补充】\n补充原工作`);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM continuations WHERE kind='question_answer'").get().n,1);
  await f.send('/任务');await f.send('/clear');await f.send('1');await f.send('999.未知题号');assert.equal(f.last(),undefined);assert.equal(f.dot.dialogueActive(),true);
  await f.send('没有待答题时继续和你聊');assert.equal(f.last().intent,'conversation');
  assert.equal(f.store.tasks().length,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,0);
});

test('a conversation has one idempotent reply even after a changed update key, failure uncertainty or service restoration',async t=>{
  const f=await fixture(t);const message=f.incoming('/艾莉丝 你好');await f.bridge.receive(message);await f.bridge.receive(message);const row=f.last();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,1);
  const first=f.dot.reply({message_id:row.id,update_key:'one',text:'真实回复'});f.store.failed(first.id,'uncertain','NETWORK_ERROR');
  const second=f.dot.reply({message_id:row.id,update_key:'another',text:'不应重复发送或覆盖'});assert.equal(second.duplicate,true);
  const restored=await new DotRouter(f.options).init();assert.equal(restored.dialogueActive(),true);
  assert.equal(restored.reply({message_id:row.id,update_key:'retry',text:'又一次回复'}).duplicate,true);await restored.close();
  const replies=f.store.db.prepare('SELECT text FROM dot_chat_replies').all();assert.deepEqual(replies.map(x=>x.text),['真实回复']);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE event_key LIKE 'dot-chat-reply:%'").get().n,1);
});

test('dialogue context is bounded and owner scoped, and exit stops unprefixed conversation routing',async t=>{
  const f=await fixture(t);for(let i=0;i<9;i++){await f.send('/艾莉丝 第'+i+'轮'+'甲'.repeat(1800));f.dot.reply({message_id:f.last().id,update_key:'reply',text:'乙'.repeat(1400)});}
  const history=f.dot.dialogueHistory(f.last().id);assert.ok(history.length<=12);assert.ok(history.reduce((n,m)=>n+m.text.length,0)<=6000);assert.ok(history.some(m=>m.role==='assistant'));
  assert.equal(history.some(m=>m.text.includes('第0轮')),false);
  await f.send('/艾莉丝 退出对话');const count=f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n;await f.send('普通文字');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_requests').get().n,count);
  f.bridge.creds.peer='someone-else';assert.equal(f.dot.dialogueActive(),false);assert.throws(()=>f.dot.dialogueHistory(f.last().id),/Unknown owner/);
});

test('empty task commands and unknown continuation numbers cannot create dialogue or hidden jobs',async t=>{
  const f=await fixture(t);for(const text of ['/新任务','/艾莉丝 创建任务','/艾莉丝 继续任务 999 不猜最新聊天'])await f.send(text);
  assert.equal(f.last(),undefined);assert.equal(f.dot.dialogueActive(),false);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,0);
  await f.send('/艾莉丝 对话');await f.bridge.receive(f.incoming('外人消息',{from_user_id:'other'}));assert.equal(f.last(),undefined);
  f.dot.configure({enabled:false});assert.equal(f.dot.dialogueActive(),false);
});

test('upgrading the old request schema preserves history but never grants a fresh work claim to legacy rows',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dot-legacy-')),store=new Store(path.join(dir,'bridge.sqlite'));
  const bridge=new Bridge({store,api:{},vault:{},sessionLookup:()=>null});bridge.creds={peer:'owner',contextToken:'fixture'};
  store.db.exec('CREATE TABLE dot_requests(id TEXT PRIMARY KEY,owner TEXT NOT NULL,inbound_id TEXT UNIQUE NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,prepared INTEGER,action TEXT,target TEXT,session_id TEXT,task_number INTEGER)');
  store.db.prepare("INSERT INTO dot_requests(id,owner,inbound_id,text,state,created) VALUES (?,?,?,?,?,?)").run('legacy',hash('owner'),'old','旧请求','queued',Date.now());
  const dot=new DotRouter({bridge,store,vault:{load:async()=>null,save:async()=>{}}});t.after(async()=>{await dot.close();await bridge.close();store.close();});
  dot.configure({enabled:true,native_dispatch:true});assert.equal(dot.request('legacy').intent,'legacy');assert.equal(dot.request('legacy').text,'旧请求');
  assert.throws(()=>dot.prepare({message_id:'legacy',action:'create'}),/legacy/);assert.throws(()=>dot.native.enqueue('legacy'),/legacy/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM dot_native_jobs').get().n,0);
});
