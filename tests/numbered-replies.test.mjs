import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, resolveReply } from '../src/store.mjs';
import { Bridge } from '../src/bridge.mjs';

function setup(t, questions) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-numbered-')), 'store.sqlite');
  const store = new Store(file);
  const bridge = new Bridge({ store, api: {}, vault: { async save() {} } });
  bridge.creds = {peer:'owner',contextToken:'fake',token:'fake'};
  t.after(async () => { await bridge.close(); store.close(); });
  const ask = (key, qs=questions) => bridge.ask({session_id:key,request_key:key,title:key,questions:qs});
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
