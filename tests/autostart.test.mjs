import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBootstrap, watchService, startLocalService} from '../src/bootstrap.mjs';
import {handleHook} from '../src/hook.mjs';
import {sleep,ROOT,VERSION,localApi} from '../src/common.mjs';
import {spawn} from 'node:child_process';
import http from 'node:http';

const refused=()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNREFUSED'}});
function fixture(){return fs.mkdtempSync(path.join(os.tmpdir(),'codex-wechat-start-'));}

test('an occupied port exits a duplicate service before shared state, timers or WeChat polling begin',async()=>{
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const state=fixture(),child=spawn(process.execPath,[path.join(ROOT,'src','service.mjs')],{env:{...process.env,CODEX_WECHAT_STATE:state,CODEX_WECHAT_PORT:String(server.address().port)},windowsHide:true,stdio:['ignore','ignore','pipe']});child.stderr.resume();
  try{
    const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Duplicate service remained alive')),3000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
    assert.equal(code,1);assert.equal(fs.existsSync(path.join(state,'bridge.sqlite')),false);assert.equal(fs.existsSync(path.join(state,'control.token')),false);
  }finally{child.kill();await new Promise(resolve=>server.close(resolve));}
});

for (const startupDelay of [0,8000]) test(`Windows launcher starts a fresh unpaired installation after ${startupDelay} ms without pre-existing connection or token files`,{skip:process.platform!=='win32'},async()=>{
  const root=fixture(),state=path.join(root,'state');fs.mkdirSync(state);fs.mkdirSync(path.join(root,'scripts'));
  for(const dir of ['src','ui','vendor'])fs.cpSync(path.join(ROOT,dir),path.join(root,dir),{recursive:true});
  if(startupDelay){const entry=path.join(root,'src','service.mjs');fs.writeFileSync(entry,`await new Promise(resolve=>setTimeout(resolve,${startupDelay}));\n`+fs.readFileSync(entry,'utf8'));}
  fs.copyFileSync(path.join(ROOT,'scripts','run-service.ps1'),path.join(root,'scripts','run-service.ps1'));
  fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify({owner:'codex-wechat-bridge',version:VERSION,node:process.execPath}));
  assert.equal(fs.existsSync(path.join(state,'connection.json')),false);assert.equal(fs.existsSync(path.join(state,'control.token')),false);
  let started=false;
  try {
    let launches=0;
    const bootstrap=createBootstrap({state,launch:()=>startLocalService({root,state,env:{...process.env,CODEX_WECHAT_PORT:'0',CODEX_HOME:path.join(root,'empty-codex-home')},spawnImpl:(command,args,options)=>{
      assert.equal(command,process.execPath);assert.equal(options.windowsHide,true);assert.equal(options.detached,true);assert.equal(options.stdio[0],'ignore');launches++;return spawn(command,args,options);
    }})});
    await bootstrap.ensure();
    started=fs.existsSync(path.join(state,'connection.json'));assert.equal(launches,1);assert.ok(started);
    const result=await localApi('/api/status',undefined,{state,timeout:3000});assert.equal(result.version,VERSION);assert.equal(result.paired,false);
  } finally {if(started||fs.existsSync(path.join(state,'connection.json')))await localApi('/api/shutdown',{}, {state,timeout:3000});}
});
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
  let wakes=0;const options={state,skillPath,api:async()=>({ok:true,chat_mode:'wechat'}),wake:async()=>{wakes++;}};
  const result=await handleHook({hook_event_name:'SessionStart',session_id:'root'},options);
  assert.ok(result.hookSpecificOutput.additionalContext.includes('当前模式=wechat'));
  assert.ok(result.hookSpecificOutput.additionalContext.includes('Always use ordinary WeChat questions.'));
  await handleHook({hook_event_name:'Stop',session_id:'root',turn_id:'turn',last_assistant_message:'Done'},options);
  assert.equal(wakes,2);assert.equal(fs.readdirSync(path.join(state,'spool')).length,1);
  await handleHook({hook_event_name:'Stop',session_id:'child',agent_id:'child'},options);assert.equal(wakes,2);
});
