export function supportsForms(capabilities={}) {
  const value=capabilities.elicitation;
  return !!value && typeof value==='object' && ('form' in value || !('url' in value));
}
export function questionForm(request,q) {
  const properties={};
  if(q.options.length)properties.choice={type:'string',title:'选择一个选项',enum:[...q.options.map((_,i)=>String(i+1)),'custom'],enumNames:[...q.options.map((o,i)=>`${i+1}. ${o.label}`),'自定义回答']};
  properties.text={type:'string',title:q.options.length?'自定义文字（填写后以文字为准）':'你的回答',maxLength:8000};
  return {mode:'form',_meta:{codex_requires_user_input:true},message:`【${request.title||'Codex 等待回答'}】第${q.number}题：${q.question}\n电脑或微信均可回答，先提交的有效答案生效。`,
    requestedSchema:{type:'object',properties,required:q.options.length?['choice']:['text']}};
}
// Actual authenticated phone answers only. This is a UI target description,
// not an execution approval or a claim that the native card has closed.
export function nativeAnswerTargets(record) {
  if(record.status!=='answered')return [];
  return record.questions.flatMap(q=>{
    const answer=record.answers[q.id];
    if(answer?.source!=='wechat'||!Array.isArray(answer.answers)||!answer.answers.length||!answer.answers.every(v=>typeof v==='string'&&v.length>0))return [];
    const text=answer.answers.join('\n'),matches=(q.options||[]).map((o,i)=>o.label===text?i+1:null).filter(n=>n!==null);
    return [{request_id:record.id,session_id:record.session_id,question_epoch:record.question_epoch,question_id:q.id,number:q.number,title:record.title,question:q.question,answer_text:text,option_number:matches.length===1?matches[0]:null,source:'wechat',ui_state:'unverified',requires_user_ui_authorization:true}];
  });
}
export class LocalForms {
  constructor(send,api) {this.send=send;this.api=api;this.pending=new Map();this.nextId=1000000;this.cancellations=new Set();}
  response(message) {
    if(message.method!==undefined||message.id===undefined)return false;
    const entry=this.pending.get(String(message.id));if(!entry)return false;
    this.pending.delete(String(message.id));entry.resolve(message);return true;
  }
  open(record,signal) {
    const active=new Map();let closed=false;
    const cancel=id=>{
      const key=String(id),e=this.pending.get(key);if(!e||e.cancelled)return;e.cancelled=true;
      const done=new Promise(resolve=>{e.cancelDone=resolve;});this.cancellations.add(done);done.finally(()=>this.cancellations.delete(done));
      this.send({method:'notifications/cancelled',params:{requestId:id,reason:'这道问题已在另一端回答、取消或过期。'}});
      e.cancelTimer=setTimeout(()=>{this.pending.delete(key);e.resolve({error:{code:-32800}});},500);
    };
    const sync=current=>{for(const [qid,id] of active)if(current.status!=='pending'||current.answers[qid]){cancel(id);active.delete(qid);}};
    const close=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',close);for(const id of active.values())cancel(id);active.clear();};
    signal.addEventListener('abort',close,{once:true});
    if(signal.aborted){close();return{sync,close};}
    for(const q of record.questions.filter(q=>!record.answers[q.id])) {
      const id=++this.nextId;active.set(q.id,id);const entry={cancelled:false};
      const response=new Promise(resolve=>{entry.resolve=message=>{clearTimeout(entry.cancelTimer);entry.cancelDone?.();resolve(message);};this.pending.set(String(id),entry);});
      response.then(async message=>{
        if(entry.cancelled||closed||signal.aborted||message.error||message.result?.action!=='accept')return;
        const content=message.result.content;
        if(!content||typeof content!=='object')return;
        const choice=/^[1-8]$/.test(String(content.choice))?Number(content.choice):undefined;
        await this.api(`/api/requests/${record.id}/answer`,{question_id:q.id,choice,text:content.text,source:'codex'},{timeout:5000});
      }).catch(()=>{});
      this.send({id,method:'elicitation/create',params:questionForm(record,q)});
    }
    return{sync,close};
  }
  async settle(){await Promise.all([...this.cancellations]);}
}
