import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, STATE, localApi, safeError, sleep} from './common.mjs';

export async function startRegisteredService({root=ROOT, spawnImpl=spawn}={}) {
  if (process.platform!=='win32') throw Object.assign(new Error('Windows service launcher required'),{code:'WINDOWS_REQUIRED'});
  const shell=process.env.CODEX_WECHAT_POWERSHELL || path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  await new Promise((resolve,reject)=>{
    const child=spawnImpl(shell,['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','service-task.ps1'),'-Action','Start'],{windowsHide:true,stdio:['ignore','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();reject(Object.assign(new Error('Service start timed out'),{code:'SERVICE_START_TIMEOUT'}));},5000);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Object.assign(new Error('Registered service could not start'),{code:'SERVICE_START_FAILED'}));});
  });
}

export function createBootstrap({state=STATE,api=localApi,launch=()=>startRegisteredService(),clock=Date.now,pause=sleep}={}) {
  let current=null;
  const probe=()=>api('/api/status',undefined,{state,timeout:650});
  async function ensure({timeout=8000}={}) {
    if(fs.existsSync(path.join(state,'integration-disabled'))) throw Object.assign(new Error('Bridge explicitly disabled'),{code:'INTEGRATION_DISABLED'});
    try {return await probe();} catch(e) {if(e.status===401||e.status===403) throw Object.assign(new Error('Another service owns this port'),{code:'LOCAL_SERVICE_MISMATCH'});}
    if(current) return current;
    current=(async()=>{
      fs.mkdirSync(state,{recursive:true});
      const lock=path.join(state,'service-start.lock'); let owner=false;
      const deadline=clock()+timeout;
      try {
        try { const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);owner=true; }
        catch(e) {if(e.code!=='EEXIST')throw e;}
        if(owner) await launch();
        while(clock()<deadline) {
          try {return await probe();} catch(e) {if(e.status===401||e.status===403) throw Object.assign(new Error('Another service owns this port'),{code:'LOCAL_SERVICE_MISMATCH'});}
          if(!owner) {try{if(clock()-fs.statSync(lock).mtimeMs>20000) {fs.unlinkSync(lock);throw Object.assign(new Error('Stale service-start lease cleared'),{code:'SERVICE_START_RETRY'});}}catch(e){if(e.code!=='ENOENT')throw e;}}
          await pause(120);
        }
        throw Object.assign(new Error('WeChat service unavailable after startup'),{code:'WECHAT_SERVICE_UNAVAILABLE'});
      } finally {if(owner)try{fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')throw e;}}
    })();
    try{return await current;}finally{current=null;}
  }
  async function request(route,body,options={}) {
    await ensure();
    try {return await api(route,body,{state,...options});}
    catch(e) {
      // Only a rejected connection is known not to have reached the API. Do not
      // replay a POST whose response merely timed out after possible acceptance.
      if(e.cause?.code!=='ECONNREFUSED') throw e;
      await ensure(); return api(route,body,{state,...options});
    }
  }
  return {ensure,request};
}

export function watchService(bootstrap,{interval=15000}={}) {
  let busy=false,closed=false,lastError=null;
  const tick=async()=>{if(busy||closed)return;busy=true;try{await bootstrap.ensure();lastError=null;}catch(e){lastError=safeError(e);}finally{busy=false;}};
  const timer=setInterval(tick,interval);timer.unref();void tick();
  return {close(){closed=true;clearInterval(timer);},status(){return {watching:!closed,error:lastError};}};
}
