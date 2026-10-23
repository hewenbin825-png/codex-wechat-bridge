import {hash,summary} from './common.mjs';

const sessionId=value=>/^[0-9a-f-]{36}$/i.test(value||'');

// The remote plugin supplies only an existing owner request ID. The prompt,
// target and creation policy are loaded locally, never supplied by Dot.
export class DotNativeDispatch {
  constructor(router) {
    this.router=router;this.bridge=router.bridge;this.store=router.store;this.clock=router.clock;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS dot_native_jobs (
      message_id TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,
      created INTEGER NOT NULL,updated INTEGER NOT NULL,worker_id TEXT,
      session_id TEXT,error TEXT NOT NULL DEFAULT '');`);
    this.store.db.prepare("UPDATE dot_native_jobs SET state='uncertain',error='PROCESS_RESTART_DURING_NATIVE_DISPATCH' WHERE state='dispatching'").run();
  }
  enabled(){return this.router.enabled()&&this.store.meta('dot_native_dispatch')==='true';}
  ready(){return this.enabled()&&!!this.bridge.desktop?.canCreateCodex?.();}
  configure(enabled){
    if(typeof enabled!=='boolean')throw new Error('Native dispatch must be a boolean');
    this.store.meta('dot_native_dispatch',enabled);
    if(!enabled)this.store.db.prepare("UPDATE dot_native_jobs SET state=CASE WHEN state='queued' THEN 'cancelled' ELSE 'uncertain' END,error='NATIVE_DISPATCH_DISABLED' WHERE state IN ('queued','dispatching','awaiting_binding')").run();
  }
  status(){return {enabled:this.enabled(),ready:this.ready(),connected:this.bridge.desktop?.canCreateCodex?.()===true,provider:'official_codex_app_tools',queued:this.store.db.prepare("SELECT count(*) AS n FROM dot_native_jobs WHERE owner=? AND state IN ('queued','dispatching','awaiting_binding')").get(this.router.owner()).n};}
  row(id){return this.store.db.prepare('SELECT * FROM dot_native_jobs WHERE message_id=? AND owner=?').get(id,this.router.owner());}
  result(id){
    const request=this.router.request(id),job=this.row(id);
    return {message_id:id,state:job?.state||'not_queued',session_id:request.session_id||job?.session_id||null,task_number:request.task_number||null,error:job?.error||'',
      instruction:request.state==='bound'?'Use the returned Codex work chat. Do not create another chat.':'Read this request again if pending. Never repeat native creation after an uncertain result.'};
  }
  enqueue(id){
    this.sweep();
    const request=this.router.request(id);
    if(this.row(id))return this.result(id);
    if(!this.ready())throw new Error('Native Codex dispatcher is not enabled and connected');
    if(request.state!=='prepared'||!['create','continue'].includes(request.action))throw new Error('Claim the owner request before dispatch');
    this.store.db.prepare("INSERT OR IGNORE INTO dot_native_jobs(message_id,owner,state,created,updated) VALUES (?,?,'queued',?,?)").run(id,this.router.owner(),this.clock(),this.clock());
    return this.result(id);
  }
  async wait(id,timeout=15000){
    const deadline=Date.now()+Math.max(0,timeout);
    // An App Tools lease may renew a few seconds after its prior lease ends.
    // Wait inside this call only; never leave hidden work after an unready error.
    while(!this.row(id)&&this.enabled()&&!this.ready()){
      const request=this.router.request(id);
      if(request.state!=='prepared'||!['create','continue'].includes(request.action)||Date.now()>=deadline)break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(100,Math.max(1,deadline-Date.now()))));
    }
    this.enqueue(id);
    for(;;){const current=this.result(id);if(!['queued','dispatching','awaiting_binding'].includes(current.state)||Date.now()>=deadline)return current;await new Promise(resolve=>setTimeout(resolve,100));}
  }
  claim(worker){
    if(!this.ready())return null;
    this.sweep();
    const row=this.store.db.prepare("SELECT n.*,r.text,r.action,r.target FROM dot_native_jobs n JOIN dot_requests r ON n.message_id=r.id AND n.owner=r.owner WHERE n.owner=? AND n.state='queued' AND r.state='prepared' ORDER BY n.created LIMIT 1").get(this.router.owner());
    if(!row)return null;
    if(row.action==='continue'){
      const meta=this.bridge.sessionLookup(row.target);
      if(!meta?.root||meta.archived){this.store.db.prepare("UPDATE dot_native_jobs SET state='failed',error='ORIGINAL_CHAT_UNAVAILABLE' WHERE message_id=?").run(row.message_id);return null;}
    }
    const changed=this.store.db.prepare("UPDATE dot_native_jobs SET state='dispatching',worker_id=?,updated=? WHERE message_id=? AND state='queued'").run(worker,this.clock(),row.message_id).changes;
    return changed?{kind:'dot_work',id:row.message_id,action:row.action,session_id:row.target||null,prompt:row.text,title:summary(row.text,60),directory_name:'dot-work-'+hash(row.message_id).slice(0,16)}:null;
  }
  finish({worker_id,id,state,session_id,error=''}){
    const row=this.row(id);
    if(!row||row.state!=='dispatching'||row.worker_id!==worker_id)throw new Error('Unknown native dispatch or worker');
    if(!['delivered','failed','uncertain'].includes(state))throw new Error('Invalid native dispatch result');
    if(state==='delivered'&&!sessionId(session_id))throw new Error('Actual Codex threadId required');
    this.store.db.prepare('UPDATE dot_native_jobs SET state=?,session_id=?,error=?,updated=? WHERE message_id=?').run(state==='delivered'?'awaiting_binding':state,session_id||null,String(error).slice(0,64),this.clock(),id);
    this.sweep();return this.result(id);
  }
  sweep(){
    if(!this.enabled())return;
    const owner=this.router.owner(),at=this.clock();
    for(const row of this.store.db.prepare("SELECT * FROM dot_native_jobs WHERE owner=? AND state IN ('queued','dispatching','awaiting_binding')").all(owner)){
      if(row.state==='awaiting_binding'){
        const meta=this.bridge.sessionLookup(row.session_id);
        if(meta){
          try{this.router.bind({message_id:row.message_id,session_id:row.session_id});this.store.db.prepare("UPDATE dot_native_jobs SET state='bound',updated=? WHERE message_id=?").run(at,row.message_id);}
          catch{this.store.db.prepare("UPDATE dot_native_jobs SET state='uncertain',error='WORK_CHAT_BINDING_REJECTED',updated=? WHERE message_id=?").run(at,row.message_id);}
          continue;
        }
      }
      const expired=row.state==='queued'?at-row.created>120000:at-row.updated>90000;
      if(expired)this.store.db.prepare("UPDATE dot_native_jobs SET state=?,error='NATIVE_DISPATCH_EXPIRED',updated=? WHERE message_id=?").run(row.state==='queued'?'failed':'uncertain',at,row.message_id);
    }
  }
}
