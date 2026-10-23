import { AppClient } from './app-client.mjs';
import { localApi, randomId, safeError } from './common.mjs';

export class CompletionMonitor {
  constructor(api, emit, clock = Date.now) { Object.assign(this,{api,emit,clock}); this.seen = new Map(); this.started = clock(); }
  async scan(roots) {
    const allowed = new Set(roots);
    const listing = await this.api.call('list_threads',{limit:50});
    for (const thread of [...(listing.pinnedThreads || []),...(listing.threads || [])]) {
      if (!allowed.has(thread.id) || thread.kind !== 'codex' || (thread.hostId && thread.hostId !== 'local')) continue;
      const previous = this.seen.get(thread.id);
      const status = typeof thread.status === 'string' ? thread.status : thread.status?.type;
      const stamp = `${thread.updatedAt || thread.updated_at || ''}:${status}`;
      this.seen.set(thread.id,{stamp,active:status === 'active'});
      if (!previous || status === 'active' || (!previous.active && previous.stamp === stamp)) continue; // Initial history is a baseline, never a notification replay.
      try {
        const result = await this.api.call('read_thread',{threadId:thread.id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1500});
        const turn = result.turns?.[0];
        if (!turn || turn.status !== 'completed') { this.seen.set(thread.id,previous); continue; }
        const final = (turn.items || []).filter(i => i.type === 'agentMessage' && i.phase === 'final').map(i => i.text).join('\n');
        if (!final) continue;
        await this.emit('/api/events',{kind:'notify',payload:{type:'agent-turn-complete','thread-id':thread.id,'turn-id':turn.id,'last-assistant-message':final}});
      } catch (e) { this.seen.set(thread.id,previous); throw e; }
    }
  }
}

export class DesktopWorker {
  constructor({api = localApi,clientFactory = session => new AppClient(session),clock = Date.now} = {}) {
    Object.assign(this,{api,clientFactory,clock}); this.id = randomId(); this.closed = false; this.busy = false; this.dispatching = false; this.lastScan = 0; this.retryAt = 0;
  }
  connect(session) {
    if (this.closed || this.client || this.starting || this.clock() < this.retryAt || !/^[0-9a-f-]{36}$/i.test(session || '')) return;
    this.session = session;
    if(!this.timer){this.timer=setInterval(()=>this.tick().catch(()=>{}),3000);this.timer.unref();}
    this.starting = (async () => {
      const client = this.clientFactory(session);
      try { await client.start(); if (this.closed) { await client.close(); return; } this.client = client; this.monitor = new CompletionMonitor(client,this.api,this.clock); clearInterval(this.timer); this.timer = setInterval(() => this.tick().catch(() => {}),3000); this.timer.unref(); await this.tick(); }
      catch (e) { await client.close(); this.client = null; this.retryAt = this.clock()+30000; this.error = safeError(e); }
      finally { this.starting = null; }
    })();
  }
  async tick() {
    if (this.busy || this.closed) return;
    if(!this.client){this.connect(this.session);return;}
    this.busy = true;
    let verifying=false;
    try {
      // Renew well before the 20 second server lease expires.
      if (this.client.healthy && !this.client.healthy(10000)) {verifying=true;await this.client.call('list_threads',{limit:1});verifying=false;}
      const registration = await this.api('/api/desktop/register',{worker_id:this.id,session_id:this.session,verified_at:this.client.verifiedAt || this.clock(),capabilities:{create_codex_threads:this.client.supports?.('create_thread')===true}},{timeout:2500});
      if (!registration.active) return;
      const poll = await this.api('/api/desktop/poll',{worker_id:this.id,busy:this.dispatching},{timeout:2500});
      if (poll.job && !this.dispatching) { this.dispatching = true; this.delivery = this.dispatch(poll.job).finally(() => {this.dispatching=false;}); }
      if (!this.scanning && this.clock()-this.lastScan >= 5000) {
        this.lastScan = this.clock(); this.scanning = true;
        this.scan = this.monitor.scan(registration.sessions).catch(e => {this.error=safeError(e);}).finally(() => {this.scanning=false;});
      }
    } catch (e) {
      this.error = safeError(e);
      // Reopen only the inherited official capability, never replay work.
      if(verifying&&!this.dispatching){const client=this.client;this.client=null;this.retryAt=this.clock()+30000;await client.close().catch(()=>{});}
    }
    finally { this.busy = false; }
  }
  async dispatch(job) {
    let state = 'delivered', error = '',session_id=job.session_id;
    try {
      if(job.kind==='dot_work'&&!['create','continue'].includes(job.action))throw Object.assign(new Error('Invalid native action'),{code:'INVALID_NATIVE_ACTION',preflight:true});
      if(job.kind==='dot_work'&&job.action==='create'){
        const created=await this.client.call('create_thread',{prompt:job.prompt,title:job.title,target:{type:'projectless',directoryName:job.directory_name}});
        if(!/^[0-9a-f-]{36}$/i.test(created.threadId||'')||created.clientThreadId||(created.hostId&&created.hostId!=='local'))throw Object.assign(new Error('Actual local threadId not yet confirmed'),{code:'CODEX_CREATION_UNCONFIRMED'});
        session_id=created.threadId;
      }else await this.client.call('send_message_to_thread',{threadId:job.session_id,hostId:'local',prompt:job.prompt});
    } catch (e) { state = e.preflight ? 'failed' : 'uncertain'; error = String(e.code || 'DESKTOP_DISPATCH_FAILED'); }
    await this.api('/api/desktop/result',{worker_id:this.id,id:job.id,state,error,...(job.kind==='dot_work'?{kind:job.kind,session_id}: {})},{timeout:3000}).catch(() => {});
  }
  async close() { this.closed = true; clearInterval(this.timer);await this.api('/api/desktop/unregister',{worker_id:this.id},{timeout:1000}).catch(()=>{}); await this.client?.close(); await this.starting; }
}
