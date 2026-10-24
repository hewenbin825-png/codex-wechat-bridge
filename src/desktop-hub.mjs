// Only one connected MCP worker owns delivery at a time. No desktop pipe or
// credential is exposed through this API or persisted in bridge state.
export class DesktopHub {
  constructor(bridge, sessions, clock = Date.now) { Object.assign(this, { bridge, sessions, clock }); this.worker = null; this.workers=new Map();bridge.desktop = this; }
  select() {
    for(const [id,worker] of this.workers)if(worker.expires<=this.clock())this.workers.delete(id);
    if(this.worker&&this.workers.has(this.worker.id)&&this.worker.expires>this.clock())return this.worker;
    this.worker=[...this.workers.values()].sort((a,b)=>Number(b.create_codex_threads)-Number(a.create_codex_threads))[0]||null;
    return this.worker;
  }
  ready() { return !!this.select(); }
  canCreateCodex(){return this.ready()&&this.worker.create_codex_threads===true;}
  register({ worker_id, session_id, verified_at = this.clock(),capabilities={} }) {
    if (!/^[0-9a-f-]{36}$/i.test(worker_id || '') || !this.bridge.sessionLookup(session_id)?.root) throw new Error('A verified main chat is required');
    if (!Number.isFinite(verified_at) || verified_at < this.clock()-20000 || verified_at > this.clock()+5000) return {active:false};
    const candidate={id:worker_id,session:session_id,create_codex_threads:capabilities.create_codex_threads===true,expires:Math.min(this.clock()+20000,verified_at+20000)};
    const current=this.select();this.workers.set(worker_id,candidate);
    if(!current||current.id===worker_id||(candidate.create_codex_threads&&!current.create_codex_threads))this.worker=candidate;
    if(this.worker.id!==worker_id)return {active:false};
    return { active: true, sessions: this.sessions().filter(({id})=>this.bridge.store.chatMode(id)==='wechat').map(({id}) => id) };
  }
  unregister({worker_id}) {this.workers.delete(worker_id);if(this.worker?.id===worker_id)this.worker=null;this.select();return {ok:true};}
  poll({worker_id,busy = false}) {
    if (!this.ready() || this.worker.id !== worker_id) return { active: false };
    let job = busy ? null : this.bridge.store.claimContinuation(worker_id);
    if (job) {
      const meta = this.bridge.sessionLookup(job.session_id);
      if (!meta?.root || meta.archived) { this.result({worker_id,id:job.id,state:'failed',error:'ORIGINAL_CHAT_UNAVAILABLE'}); job = null; }
    }
    if(!job&&!busy&&this.canCreateCodex())job=this.bridge.dot?.native.claim(worker_id)||null;
    return { active: true, job };
  }
  result({worker_id,id,state,error = '',kind,session_id}) {
    if(kind==='dot_work')return this.bridge.dot.native.finish({worker_id,id,state,error,session_id});
    const job = this.bridge.store.finishContinuation(id, worker_id, state, error);
    if (!job) throw new Error('Unknown dispatch or worker');
    const retired=job.task_epoch!==Number(this.bridge.store.meta('task_epoch')||0);
    const label=retired?(job.question_number?'已清理编号的原问题':'已清理编号的原任务'):job.question_number?`第${job.question_number}题的${job.kind==='question_answer'?'回答':'补充'}`:`任务 ${job.task_number}`;
    const text = state === 'delivered' ? `已提交到${label}的原聊天。请在原聊天查看执行进度；原有执行审批仍需在 Codex 处理。`
      : state === 'uncertain' ? `${label}的投递结果暂不能确认，未自动重发。请先查看原聊天，避免重复执行。`
      : `${label}尚未投递成功。请连接 Codex 后重新发送下一步要求。`;
    if (this.bridge.creds&&this.bridge.store.chatMode(job.session_id)==='wechat') this.bridge.store.enqueue({key:`continuation-result:${id}`,kind:'receipt',session_id:job.session_id,peer:this.bridge.creds.peer,text,ttl_ms:3600000});
    return {ok:true};
  }
  sweep() {
    for (const job of this.bridge.store.staleContinuations()) if (this.bridge.creds&&this.bridge.store.chatMode(job.session_id)==='wechat') this.bridge.store.enqueue({key:`continuation-result:${job.id}`,kind:'receipt',session_id:job.session_id,peer:this.bridge.creds.peer,
      text:`${job.question_number?`第${job.question_number}题的补充`:`任务 ${job.task_number}`} ${job.state === 'queued' ? '等待桌面连接已超时，尚未提交。连接后请重发。' : '投递结果待核对，未自动重发。请先查看原聊天。'}`,ttl_ms:3600000});
  }
}
