import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, resolveReply } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';
import { clearCommand,continuationCommand } from '../src/tasks.mjs';

function setup(t, questions) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-numbered-')), 'store.sqlite');
  const store = new Store(file);
  const bridge = new Bridge({ store, api: {}, vault: { async save() {} } });
  bridge.creds = {peer:'owner',contextToken:'fake',token:'fake'};
  t.after(async () => { await bridge.close(); store.close(); });
  const ask = (key, qs=questions) => (store.setChatMode(key,'wechat'),bridge.ask({presentation:'chat_text',session_id:key,request_key:key,title:key,questions:qs}));
  let id = 0;
  const reply = text => bridge.receive({from_user_id:'owner',message_type:1,message_id:String(++id),create_time_ms:Date.now(),context_token:'fake',item_list:[{type:1,text_item:{text}}]});
  return {store,bridge,ask,reply,file};
}
const choice = id => ({id,question:'下一步怎么处理？',options:[{label:'继续'},{label:'暂停'}]});

test('bare option numbers and unprefixed custom text work for a single pending question', async t => {
  const f=setup(t,[choice('one')]);
  let r=f.ask('a'); await f.reply('2');
  assert.deepEqual(f.store.request(r.id).answers.one.answers,['暂停']);
  r=f.ask('b'); await f.reply('先保留现场，再把原因整理给我');
  assert.deepEqual(f.store.request(r.id).answers.one.answers,['先保留现场，再把原因整理给我']);
});

test('question.option replies can arrive out of order without renumbering remaining questions', async t => {
  const f=setup(t,[choice('one'),choice('two')]);const r=f.ask('a');
  assert.deepEqual(r.questions.map(q=>q.number),[1,2]);
  await f.reply('2.2');
  assert.deepEqual(f.store.request(r.id).answers.two.answers,['暂停']);
  assert.equal(f.store.request(r.id).status,'pending');
  await f.reply('1.1');
  assert.deepEqual(f.store.request(r.id).answers.one.answers,['继续']);
  assert.equal(f.store.request(r.id).status,'answered');
});

test('numbered free text, parentheses and multiline custom answers map to the specified question', async t => {
  const f=setup(t,[choice('one'),choice('two')]);const r=f.ask('a');
  await f.reply('（2.这样改）');
  assert.deepEqual(f.store.request(r.id).answers.two.answers,['这样改']);
  await f.reply('1.请先改标题\n然后把说明缩短');
  assert.deepEqual(f.store.request(r.id).answers.one.answers,['请先改标题\n然后把说明缩短']);
});

test('concurrent chats have distinct numbers; ambiguous, invalid and repeated numbers cannot cross-answer', async t => {
  const f=setup(t,[choice('one')]);const a=f.ask('a'),b=f.ask('b');
  assert.notEqual(a.questions[0].number,b.questions[0].number);
  await f.reply('1');await f.reply('99.1');await f.reply('1.9');
  assert.deepEqual(f.store.request(a.id).answers,{});assert.deepEqual(f.store.request(b.id).answers,{});
  await f.reply('1.1');await f.reply('1.2');
  assert.equal(f.store.request(b.id).status,'pending');
  await f.reply('2.这样改');
  assert.deepEqual(f.store.request(b.id).answers.one.answers,['这样改']);
});

test('question numbers survive restart and are not reused for a later question', () => {
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'wechat-number-persist-')),'store.sqlite');
  let store=new Store(file);
  const a=store.createRequest({request_key:'a',session_id:'a',questions:[choice('one')]});
  store.close();store=new Store(file);
  assert.equal(store.request(a.id).questions[0].number,1);
  store.cancel(a.id);
  const b=store.createRequest({request_key:'b',session_id:'b',questions:[choice('one')]});
  assert.equal(b.questions[0].number,2);
  assert.equal(resolveReply(store.pending(),'1.1').ok,false);
  assert.equal(store.request(b.id).status,'pending');store.close();
});

test('legacy pending records receive stable numbers on upgrade and keep the original Q-code route', () => {
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'wechat-number-upgrade-')),'store.sqlite');
  let store=new Store(file);
  const a=store.createRequest({request_key:'a',session_id:'a',questions:[choice('one')]});
  const legacy=a.questions.map(({number,...q})=>q);
  store.db.prepare('UPDATE requests SET questions=? WHERE id=?').run(JSON.stringify(legacy),a.id);
  store.close();store=new Store(file);
  const migrated=store.request(a.id);
  assert.ok(migrated.questions[0].number>0);
  assert.equal(resolveReply(store.pending(),`${legacy[0].code} 1`).answer,'继续');
  const n=migrated.questions[0].number;store.close();store=new Store(file);
  assert.equal(store.request(a.id).questions[0].number,n);store.close();
});

test('/clear retires question and task numbers, cancels queued prompts and preserves chat history and completion dedup',async t=>{
  const f=setup(t,[choice('one')]),answered=f.ask('answered');await f.reply('1');
  const supplement=f.store.enqueueQuestionSupplement(f.store.request(answered.id),answered.questions[0],'旧题补充','supplement-id');
  const {task}=f.store.completeTask('existing-work','completed-turn','原工作');
  const continuation=f.store.enqueueContinuation(task,'下一步要求','task-next');
  f.store.enqueue({key:'completion:existing-work:completed-turn',peer:'owner',text:'原完成摘要'});
  const a=f.ask('a'),b=f.ask('b');let changed=0;f.bridge.on('changed',()=>changed++);
  await f.reply('/clear');
  assert.equal(f.store.request(a.id).status,'cancelled');assert.equal(f.store.request(b.id).status,'cancelled');
  assert.equal(f.store.questionByNumber(answered.questions[0].number),null);
  assert.equal(f.store.continuation(supplement.id).state,'cancelled');assert.equal(f.store.continuation(continuation.id).state,'cancelled');
  assert.equal(f.store.tasks().length,0);assert.equal(f.store.db.prepare('SELECT session_id FROM task_number_history').get().session_id,'existing-work');
  assert.equal(f.store.completeTask('existing-work','completed-turn','重复旧摘要').duplicate,true);assert.equal(f.store.tasks().length,0);
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE kind='completion'").get().state,'cancelled');
  assert.equal(changed,1);assert.equal(f.ask('after-clear').questions[0].number,1);
});

test('/clear restarts task numbering at one across restart, and repeated completions do not consume numbers',()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'wechat-clear-tasks-')),'store.sqlite');let store=new Store(file);
  try{
    store.completeTask('old','old-turn','旧任务');store.clearQuestions();store.close();store=new Store(file);
    assert.equal(store.tasks().length,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_number_history').get().n,1);
    assert.equal(store.completeTask('old','old-turn','旧回放').duplicate,true);
    assert.equal(store.completeTask('new','first','新任务').task.number,1);
    assert.equal(store.completeTask('new','second','新任务第二轮').task.number,1);
    assert.equal(store.completeTask('another','first','另一个任务').task.number,2);
    store.close();store=new Store(file);assert.deepEqual(store.tasks().map(t=>t.number),[1,2]);
  }finally{store.close();}
});

test('/clear allows in-flight original delivery to finish without touching a reused task number or accepting an old slash',async t=>{
  const f=setup(t,[choice('one')]),old=f.store.completeTask('old','first','旧任务').task;
  f.bridge.sessionLookup=()=>({root:true});
  const queued=f.store.enqueueContinuation(old,'旧工作已经开始','in-flight'),job=f.store.claimContinuation('worker');assert.equal(job.id,queued.id);
  await f.reply('/clear');const fresh=f.store.completeTask('new','first','新任务').task;assert.equal(fresh.number,1);
  f.store.enqueueContinuation(fresh,'新工作待办','new-queued');f.store.finishContinuation(job.id,'worker','delivered');
  assert.equal(f.store.task(1).session_id,'new');assert.equal(f.store.task(1).state,'queued');
  f.store.completeTask('new','second','新任务');
  await f.bridge.receive({from_user_id:'owner',message_type:1,message_id:'stale-task',create_time_ms:Date.now()-10000,item_list:[{type:1,text_item:{text:'/1 清理前的要求'}}]});
  assert.match(f.store.db.prepare("SELECT text FROM outbox WHERE kind='receipt' ORDER BY rowid DESC LIMIT 1").get().text,/早于/);
});

test('/clear resets persist across restarts without reviving larger historical question numbers',()=>{
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'wechat-clear-persist-')),'store.sqlite');let store=new Store(file);
  try{
    const old=store.createRequest({request_key:'old',session_id:'old',questions:[choice('one'),choice('two'),choice('three')]});
    store.clearQuestions();store.close();store=new Store(file);
    assert.equal(store.questionByNumber(3),null);assert.equal(store.request(old.id).status,'cancelled');
    const first=store.createRequest({request_key:'new-one',session_id:'new',questions:[choice('one')]});assert.equal(first.questions[0].number,1);
    store.close();store=new Store(file);
    assert.equal(store.createRequest({request_key:'new-two',session_id:'new',questions:[choice('two')]}).questions[0].number,2);
  }finally{store.close();}
});

test('unauthorized, duplicated and stale /clear messages cannot clear a newer question',async t=>{
  const f=setup(t,[choice('one')]),old=f.ask('old');
  const message={from_user_id:'owner',message_type:1,message_id:'clear-once',create_time_ms:Date.now(),item_list:[{type:1,text_item:{text:'/clear'}}]};
  await f.bridge.receive({...message,from_user_id:'other'});assert.equal(f.store.request(old.id).status,'pending');
  await f.bridge.receive(message);const current=f.ask('new');
  assert.equal((await f.bridge.receive(message)).duplicate,true);assert.equal(f.store.request(current.id).status,'pending');
  await f.bridge.receive({...message,message_id:'delayed-clear',create_time_ms:Date.now()-10000});assert.equal(f.store.request(current.id).status,'pending');
});

test('old forms, Q codes and pre-clear replies cannot answer a reused number in another chat',async t=>{
  const f=setup(t,[choice('one')]),old=f.ask('old');await f.reply('/clear');const current=f.ask('new');
  assert.equal(current.questions[0].number,old.questions[0].number);
  assert.equal(f.bridge.answerLocal(old.id,{question_id:'one',choice:2}).accepted,false);
  await f.reply(old.questions[0].code+' 2');
  await f.bridge.receive({from_user_id:'owner',message_type:1,message_id:'delayed-answer',create_time_ms:Date.now()-10000,item_list:[{type:1,text_item:{text:'1.2'}}]});
  assert.deepEqual(f.store.request(current.id).answers,{});
  await f.reply('1');assert.deepEqual(f.store.request(current.id).answers.one.answers,['继续']);
});

test('/clear is reserved from task continuation; plain clear remains an ordinary custom answer',async t=>{
  const tasks=[{number:1,state:'completed'}];
  for(const text of ['/clear','/CLEAR','（/clear）','/clear extra'])assert.ok(continuationCommand(text,tasks).error);
  assert.equal(clearCommand('clear'),null);assert.equal(clearCommand('（/CLEAR）').clear,true);
  const f=setup(t,[choice('one')]),r=f.ask('a');await f.reply('/clear extra');assert.equal(f.store.request(r.id).status,'pending');
  await f.reply('clear');assert.deepEqual(f.store.request(r.id).answers.one.answers,['clear']);
});
