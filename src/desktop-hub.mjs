// Only one connected MCP worker owns delivery at a time. No desktop pipe or
// credential is exposed through this API or persisted in bridge state.
export class DesktopHub {
  constructor(bridge, sessions, clock = Date.now) { Object.assign(this, { bridge, sessions, clock }); this.worker = null; bridge.desktop = this; }
  ready() { return !!this.worker && this.worker.expires > this.clock(); }
  register({ worker_id, session_id, verified_at = this.clock() }) {
    if (!/^[0-9a-f-]{36}$/i.test(worker_id || '') || !this.bridge.sessionLookup(session_id)?.root) throw new Error('A verified main chat is required');
    if (this.ready() && this.worker.id !== worker_id) return { active: false };
    if (!Number.isFinite(verified_at) || verified_at < this.clock()-20000 || verified_at > this.clock()+5000) return {active:false};
    this.worker = { id: worker_id, session: session_id, expires: Math.min(this.clock()+20000,verified_at+20000) };
    return { active: true, sessions: this.sessions().map(({id}) => id) };
  }
  poll({worker_id,busy = false}) {
    if (!this.ready() || this.worker.id !== worker_id) return { active: false };
    let job = busy ? null : this.bridge.store.claimContinuation(worker_id);
    if (job) {
      const meta = this.bridge.sessionLookup(job.session_id);
      if (!meta?.root || meta.archived) { this.result({worker_id,id:job.id,state:'failed',error:'ORIGINAL_CHAT_UNAVAILABLE'}); job = null; }
    }
    return { active: true, job };
  }
  result({worker_id,id,state,error = ''}) {
    const job = this.bridge.store.finishContinuation(id, worker_id, state, error);
    if (!job) throw new Error('Unknown dispatch or worker');
    const text = state === 'delivered' ? `已提交到任务 ${job.task_number} 的原聊天。请在原聊天查看执行进度；原有执行审批仍需在 Codex 处理。`
      : state === 'uncertain' ? `任务 ${job.task_number} 的投递结果暂不能确认，未自动重发。请先查看原聊天，避免重复执行。`
      : `任务 ${job.task_number} 尚未投递成功。请连接 Codex 后重新发送下一步要求。`;
    if (this.bridge.creds) this.bridge.store.enqueue({key:`continuation-result:${id}`,kind:'receipt',peer:this.bridge.creds.peer,text,ttl_ms:3600000});
    return {ok:true};
  }
  sweep() {
    for (const job of this.bridge.store.staleContinuations()) if (this.bridge.creds) this.bridge.store.enqueue({key:`continuation-result:${job.id}`,kind:'receipt',peer:this.bridge.creds.peer,
      text:`任务 ${job.task_number} ${job.state === 'queued' ? '等待桌面连接已超时，尚未提交。连接后请重发。' : '投递结果待核对，未自动重发。请先查看原聊天。'}`,ttl_ms:3600000});
  }
}
