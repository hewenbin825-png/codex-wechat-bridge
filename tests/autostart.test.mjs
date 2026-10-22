import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBootstrap, watchService} from '../src/bootstrap.mjs';
import {handleHook} from '../src/hook.mjs';
import {sleep} from '../src/common.mjs';

const refused=()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}});
function fixture(){return fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-start-'));}
test('an already running service is reused and simultaneous startup requests launch once',async()=>{
  const state=fixture();let ready=true,launches=0;
  const b=createBootstrap({state,api:async()=>{if(!ready)throw refused();return{version:'test'};},launch:async()=>{launches++;await sleep(15);ready=true;}});
  assert.equal((await b.ensure()).version,'test');assert.equal(launches,0);
  ready=false;await Promise.all([b.ensure(),b.ensure(),b.ensure()]);assert.equal(launches,1);
  assert.equal(fs.existsSync(path.join(state,'service-start.lock')),false);
});
test('independent MCP instances share a startup lock instead of starting duplicate services',async()=>{
  const state=fixture();let ready=false,launches=0;
  const options={state,api:async()=>{if(!ready)throw refused();return{ready:true};},launch:async()=>{launches++;await sleep(40);ready=true;}};
  const a=createBootstrap(options),b=createBootstrap(options);
  await Promise.all([a.ensure(),b.ensure()]);assert.equal(launches,1);
});
test('a crashed service is automatically recovered but unknown POST outcomes are not replayed',async()=>{
  const state=fixture();let ready=true,launches=0,posts=0,uncertain=true;
  const b=createBootstrap({state,launch:async()=>{launches++;ready=true;},api:async(route)=>{if(!ready)throw refused();if(route==='/api/ask'){posts++;if(uncertain)throw new DOMException('Timeout','TimeoutError');}return{ready:true};}});
  await assert.rejects(b.request('/api/ask',{}));assert.equal(posts,1);assert.equal(launches,0);
  ready=false;uncertain=false;await b.request('/api/ask',{});assert.equal(launches,1);assert.equal(posts,2);
});
test('explicit uninstall and an unrelated authenticated service never trigger a launcher',async()=>{
  let launches=0;const state=fixture();const b=createBootstrap({state,launch:async()=>launches++,api:async()=>{throw Object.assign(new Error('Unauthorised'),{status:401});}});
  await assert.rejects(b.ensure(),{code:'LOCAL_SERVICE_MISMATCH'});assert.equal(launches,0);
  fs.writeFileSync(path.join(state,'integration-disabled'),'disabled');
  await assert.rejects(b.ensure(),{code:'INTEGRATION_DISABLED'});assert.equal(launches,0);
});
test('MCP watchdog recovers while idle and stops checking when its connection closes',async()=>{
  let checks=0;const watch=watchService({ensure:async()=>{checks++;}},{interval:20});
  await sleep(65);assert.ok(checks>=2);watch.close();const stopped=checks;await sleep(45);assert.equal(checks,stopped);
});
test('SessionStart automatically supplies the installed skill and Stop queues before waking the service',async()=>{
  const state=fixture(),skillPath=path.join(state,'SKILL.md');fs.writeFileSync(skillPath,'---\nname: test\n---\nAlways use ordinary WeChat questions.');
  let wakes=0;const options={state,skillPath,api:async()=>({ok:true}),wake:async()=>{wakes++;}};
  const result=await handleHook({hook_event_name:'SessionStart',session_id:'root'},options);
  assert.ok(result.hookSpecificOutput.additionalContext.includes('自动应用全局 wechat-task-qa'));
  assert.ok(result.hookSpecificOutput.additionalContext.includes('Always use ordinary WeChat questions.'));
  await handleHook({hook_event_name:'Stop',session_id:'root',turn_id:'turn',last_assistant_message:'Done'},options);
  assert.equal(wakes,2);assert.equal(fs.readdirSync(path.join(state,'spool')).length,1);
  await handleHook({hook_event_name:'Stop',session_id:'child',agent_id:'child'},options);assert.equal(wakes,2);
});
