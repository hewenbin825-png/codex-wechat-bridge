import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, STATE, localApi, safeError, sleep} from './common.mjs';

export async function startLocalService({root=ROOT,state=STATE,spawnImpl=spawn,env=process.env}={}) {
  if (process.platform!=='win32') throw Object.assign(new Error('Windows service launcher required'),{code:'WINDOWS_REQUIRED'});
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'));
  if(manifest.owner!=='codex-wechat-bridge'||!fs.existsSync(manifest.node))throw Object.assign(new Error('Managed installation required'),{code:'INSTALLATION_REQUIRED'});
  fs.mkdirSync(state,{recursive:true});
  const out=fs.openSync(path.join(state,'service.stdout.log'),'a'),err=fs.openSync(path.join(state,'service.stderr.log'),'a');
  try{
  await new Promise((resolve,reject)=>{
    const child=spawnImpl(manifest.node,[path.join(root,'src','service.mjs')],{cwd:root,env:{...env,CODEX_WECHAT_STATE:state},windowsHide:true,detached:true,stdio:['ignore',out,err]});
    child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});
  });
  }finally{fs.closeSync(out);fs.closeSync(err);}
}

export function createBootstrap({state=STATE,api=localApi,launch=()=>startLocalService({state}),clock=Date.now,pause=sleep}={}) {
  let current=null;
  const probe=()=>api('/api/status',undefined,{state,timeout:650});
  async function ensure({timeout=35000}={}) {
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
          if(!owner) {try{if(clock()-fs.statSync(lock).mtimeMs>45000) {fs.unlinkSync(lock);throw Object.assign(new Error('Stale service-start lease cleared'),{code:'SERVICE_START_RETRY'});}}catch(e){if(e.code!=='ENOENT')throw e;}}
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

export function startDotWatch({root=ROOT,state=STATE,spawnImpl=spawn}={}) {
  if(process.platform!=='win32'||!['tunnel-connection.json','runtime-key.dpapi'].every(name=>fs.existsSync(path.join(state,'dot',name)))||!fs.existsSync(path.join(root,'tools','tunnel-client.exe')))return null;
  const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawnImpl(shell,['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts','start-dot-tunnel.ps1'),'-Watch','-ParentProcessId',String(process.pid)],{cwd:root,windowsHide:true,stdio:'ignore'});
  child.on('error',()=>{});child.unref();return child;
}

export function watchService(bootstrap,{interval=15000}={}) {
  let busy=false,closed=false,lastError=null;
  const tick=async()=>{if(busy||closed)return;busy=true;try{await bootstrap.ensure();lastError=null;}catch(e){lastError=safeError(e);}finally{busy=false;}};
  const timer=setInterval(tick,interval);timer.unref();void tick();
  return {close(){closed=true;clearInterval(timer);},status(){return {watching:!closed,error:lastError};}};
}
