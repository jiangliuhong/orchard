import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Plan, Status, PublicError, Job } from '../migrations/types.js';
import { questionActive, validateAnswers } from '../migrations/questions.js';
import { setBootstrapToken } from './lib/api.js';
let token:string|undefined;
let sessionId:string|undefined;
async function session(){
 const response=await fetch('/api/bootstrap/session',{headers:{'X-Orchard-Bootstrap':'1'},cache:'no-store',credentials:'same-origin'});
 if(!response.ok)throw new Error('无法取得本机升级会话，请使用当前工作台页面访问。');
 const value=await response.json();token=value.token;sessionId=value.sessionId;setBootstrapToken(token);
}
async function request<T>(path:string,body?:unknown):Promise<T>{
 if(!token)await session();
 const send=()=>fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Orchard-Bootstrap-Token':token!,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});
 let response=await send();if(response.status===401){await session();response=await send();}
 const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.message??'请求失败'),{code:value.code,fieldErrors:value.fieldErrors});return value as T;
}
interface JobView {jobId:string;phase:string;revision:number;steps:{id:string;state:string}[];processed:number;error?:{message:string};result?:Job['result']}
export function BootstrapGate({children}:{children:ReactNode}){
 const [status,setStatus]=useState<Status>({state:'checking',ready:false,revision:0});
 const [plan,setPlan]=useState<Plan>();const [job,setJob]=useState<JobView>();const [error,setError]=useState('');
 const [phase,setPhase]=useState<'overview'|'parameters'|'confirmation'|'progress'|'success'>('overview');
 const [answers,setAnswers]=useState<Record<string,unknown>>({});const [fields,setFields]=useState<Record<string,string>>({});
 const [confirmation,setConfirmation]=useState<{confirmationHash:string;expiresAt:string;summary:{id:string;summary:string}[]}>();
 const [busy,setBusy]=useState(false);const [acknowledged,setAcknowledged]=useState(false);const [collapsed,setCollapsed]=useState(false);
 const latestStatus=useRef(status);latestStatus.current=status;
 const lastRevision=useRef(-1);
 const requestId=useRef<string | undefined>(undefined);const migrateStarted=useRef(false);const entered=useRef(false);const oldSession=useRef<string | undefined>(undefined);
 const refresh=async()=>{
  try{
   if(!token)await session();const next=await request<Status>('/api/bootstrap/status');
   const changed=!!oldSession.current&&oldSession.current!==sessionId;
   if(changed){setAnswers({});setConfirmation(undefined);requestId.current=undefined;setPhase('overview');}
   oldSession.current=sessionId;
   if(changed)lastRevision.current=-1;
   if(next.revision<lastRevision.current)return;lastRevision.current=next.revision;
   setStatus(previous=>changed||next.revision>=previous.revision?next:previous);
   if(next.ready||['migrating','verifying','installing','restoring'].includes(next.state))setError('');
   if(['failed','recovery_required','initialization_failed'].includes(next.state))setPhase(previous=>{if(previous==='progress'){requestId.current=undefined;setAnswers({});return 'overview';}return previous;});
   if(next.activeJobId){const current=await request<JobView>(`/api/migrations/jobs/${next.activeJobId}`);if(next.revision<lastRevision.current)return;if(!['failed','restored','committed'].includes(current.phase)||current.phase==='committed'&&requestId.current)migrateStarted.current=true;setJob(previous=>previous?.jobId===current.jobId&&previous.revision>current.revision?previous:current);}
   if(next.ready&&migrateStarted.current&&!entered.current)setPhase('success');
   if(next.state==='migration_required'||next.state==='failed'){
    const current=await request<Plan>('/api/migrations/plan');if(next.revision<lastRevision.current)return;if(['ready','needs_input'].includes(current.status))setPlan(previous=>{if(previous&&previous.sourceFingerprint===current.sourceFingerprint&&JSON.stringify(previous.steps)===JSON.stringify(current.steps))return previous;if(previous){setAnswers({});setConfirmation(undefined);requestId.current=undefined;setPhase('overview');}return current;});else if(current.status==='blocked')setError(current.blockers.map(blocker=>blocker.message).join(' '));
   }
  }catch(failure){setError((failure as Error).message);}
 };
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  const poll=async()=>{await refresh();if(!stopped){const value=latestStatus.current;timer=setTimeout(()=>{void poll();},document.hidden?5000:['checking','migrating','verifying','installing','restoring','initializing'].includes(value.state)?1000:3000);}};
  void poll();
  const gate=()=>{setStatus({state:'checking',ready:false,revision:0});void refresh();};
  const visible=()=>{if(!document.hidden){clearTimeout(timer);void poll();}};
  window.addEventListener('orchard:not-ready',gate);document.addEventListener('visibilitychange',visible);
  return()=>{stopped=true;clearTimeout(timer);window.removeEventListener('orchard:not-ready',gate);document.removeEventListener('visibilitychange',visible);};
 },[]);
 const validate=async()=>{
  if(!plan)return;const local=validateAnswers(plan.questions,answers);if(Object.keys(local.fieldErrors).length){setFields(local.fieldErrors);return;}setBusy(true);setError('');
  try{const result=await request<{planHash:string;confirmationHash?:string;expiresAt:string;summary:{id:string;summary:string}[];fieldErrors:Record<string,string>}>('/api/migrations/validate',{planHash:plan.planHash,answers});setFields(result.fieldErrors);if(result.confirmationHash){setPlan({...plan,planHash:result.planHash});setConfirmation({...result,confirmationHash:result.confirmationHash});setPhase('confirmation');setAcknowledged(false);}}
  catch(failure){const details=failure as Error&PublicError;setError(details.message);setFields(details.fieldErrors??{});setAnswers(previous=>Object.fromEntries(Object.entries(previous).filter(([key])=>!plan.questions.some(question=>question.key===key&&question.type==='secret'))));setConfirmation(undefined);if(details.code==='PLAN_STALE'){setPlan(undefined);setPhase('overview');void refresh();}}
  finally{setBusy(false);}
 };
 const submit=async()=>{
  if(!plan||!confirmation||!acknowledged)return;
  setBusy(true);setError('');requestId.current??=crypto.randomUUID();
  try{
   const retry=status.state==='failed'&&job?`/api/migrations/jobs/${job.jobId}/retry`:'/api/migrations/jobs';
   const accepted=await request<{jobId:string}>(retry,{requestId:requestId.current,planHash:plan.planHash,confirmationHash:confirmation.confirmationHash,answers});
   migrateStarted.current=true;setAnswers({});setConfirmation(undefined);setPhase('progress');setJob(await request<JobView>(`/api/migrations/jobs/${accepted.jobId}`));void refresh();
  }catch(failure){const code=(failure as any).code;setError((failure as Error).message);if(['PLAN_STALE','CONFIRMATION_EXPIRED'].includes(code)){setConfirmation(undefined);requestId.current=undefined;setPhase('overview');void refresh();}}
  finally{setBusy(false);}
 };
 const operation=async(kind:'recover'|'initialize')=>{
  setBusy(true);setError('');requestId.current??=crypto.randomUUID();
  try{await request(kind==='recover'?`/api/migrations/jobs/${job!.jobId}/recover`:'/api/bootstrap/initialize',{requestId:requestId.current});setPhase('progress');void refresh();}
  catch(failure){setError((failure as Error).message);}finally{setBusy(false);}
 };
 const download=async()=>{
  if(!job)return;try{const report=await request(`/api/migrations/jobs/${job.jobId}/report`);const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`migration-${job.jobId}.json`;anchor.click();URL.revokeObjectURL(url);}catch(failure){setError((failure as Error).message);}
 };
 if(status.ready&&(phase!=='success'||entered.current))return <>{children}</>;
 const editable=['migration_required','failed'].includes(status.state);
 const names:Record<string,string>={checking:'正在检查数据',initializing:'正在初始化工作台',migration_required:'需要升级数据',migrating:'正在升级数据',verifying:'正在验证数据',installing:'正在安装升级结果',restoring:'正在恢复升级前数据',recovery_required:'需要恢复数据',blocked:'数据检查未通过',failed:'升级未完成',initialization_failed:'工作台初始化失败',ready:'数据已就绪'};
 return <main className="migration-wizard" aria-busy={busy}>
  <h1>{phase==='success'?'数据升级完成':names[status.state]}</h1>
  <p>当前数据目录：{status.dataDir??'检查中'}</p>
  {error&&<p role="alert">{error}</p>}{status.error&&<p role="alert">{status.error.message}</p>}
  {phase==='success'?<><p>升级已提交，工作台已就绪。</p><p>备份保留在 {job?.result?.backup??'backups/migrations/'}，不会自动删除。{job?.result&&`实际占用 ${job.result.bytes} 字节。`}</p><button onClick={()=>{entered.current=true;setPhase('overview');}}>进入工作台</button></>:<>
   {editable&&plan&&phase==='overview'&&<>
    <p>数据库 v{plan.sourceVersions.database} → v{plan.targetVersions.database}；浏览器配置 {plan.sourceVersions.webBridge===null?'首次创建':`v${plan.sourceVersions.webBridge}`} → v1</p>
    <ol>{plan.steps.map(step=><li key={step.id}>{step.summary}</li>)}</ol>
    <p>预计源数据 {(plan.estimates.bytes/1024/1024).toFixed(1)} MiB，建议至少预留 {(plan.estimates.requiredBytes/1024/1024).toFixed(1)} MiB。</p>
    <p>备份包括数据库、配置、产物、运行快照及应用内会话目录。目录外的会话仅保留引用，恢复可能需要外部工具。此次升级不调用模型、脚本或浏览器工具。</p>
    <button disabled={busy} onClick={()=>{requestId.current=undefined;setPhase('parameters');}}>继续填写参数</button>
   </>}
   {editable&&plan&&phase==='parameters'&&<form onSubmit={event=>{event.preventDefault();void validate();}}>
    <h2>升级参数</h2>{plan.questions.length===0&&<p>此次升级不需要填写参数。</p>}
    {plan.questions.map(question=>{
     const active=questionActive(question,plan.questions,answers);
     if(!active)return null;const value=answers[question.key]??(question.type==='secret'?'':question.default)??'';
     const change=(next:unknown)=>{setAnswers(previous=>{const result={...previous,[question.key]:next};for(const item of plan.questions)if(!questionActive(item,plan.questions,result))delete result[item.key];return result;});setConfirmation(undefined);};
     return <div key={question.key}><label htmlFor={`migration-${question.key}`}>{question.label}{question.required?'（必填）':''}</label>{question.description&&<p>{question.description}</p>}
      {question.type==='enum'?<select id={`migration-${question.key}`} value={String(value)} onChange={event=>change(event.target.value)}><option value="">请选择</option>{question.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:question.type==='boolean'?<input id={`migration-${question.key}`} type="checkbox" checked={value===true} onChange={event=>change(event.target.checked)}/>:<input id={`migration-${question.key}`} type={question.type==='secret'?'password':question.type==='integer'?'number':'text'} autoComplete="off" min={question.type==='integer'?question.min:undefined} max={question.type==='integer'?question.max:undefined} minLength={question.type!=='integer'?question.min:undefined} maxLength={question.type!=='integer'?question.max:undefined} pattern={question.pattern} value={String(value)} onChange={event=>change(question.type==='integer'&&event.target.value!==''?Number(event.target.value):event.target.value)}/>}
      {fields[question.key]&&<p role="alert">{fields[question.key]}</p>}
     </div>;
    })}
    <button type="button" onClick={()=>setPhase('overview')}>返回预览</button> <button disabled={busy} type="submit">验证并查看确认摘要</button>
   </form>}
   {editable&&phase==='confirmation'&&confirmation&&<>
    <h2>确认升级</h2><ol>{confirmation.summary.map(step=><li key={step.id}>{step.summary}</li>)}</ol>
    <p>程序会先保存完整备份，在副本上升级并验证，然后安装。失败后会尝试恢复；备份持续保留。</p>
    <label><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>我已确认升级范围和备份位置</label>
    <div><button onClick={()=>{setConfirmation(undefined);requestId.current=undefined;setPhase('parameters');}}>修改参数</button> <button disabled={busy||!acknowledged} onClick={()=>void submit()}>备份并开始升级</button></div>
   </>}
   {job&&<section aria-live="polite"><h2>升级任务</h2><p>阶段：{job.phase}，已处理 {job.processed} 项</p><button onClick={()=>setCollapsed(value=>!value)}>{collapsed?'展开进度':'收起进度，任务继续'}</button>{!collapsed&&<><ol>{job.steps.map(step=><li key={step.id}>{step.id}：{step.state}</li>)}</ol>{job.error&&<p>{job.error.message}</p>}<button onClick={()=>void download()}>下载脱敏诊断报告</button></>}</section>}
   {status.state==='recovery_required'&&<><p>业务仍被阻断。请保留数据、快照和任务记录，移走人工修改的冲突副本后，再尝试恢复。</p><button disabled={busy||!job} onClick={()=>void operation('recover')}>重新尝试恢复</button></>}
   {status.state==='initialization_failed'&&<><p>工作台初始化未完成，业务仍保持禁用。</p><button disabled={busy} onClick={()=>void operation('initialize')}>重试初始化</button></>}
   {status.state==='blocked'&&<p>请保留原目录并根据错误检查数据库身份、目录内容和文件权限，再重新启动。</p>}
   {!editable&&!['blocked','failed','recovery_required','initialization_failed'].includes(status.state)&&<p role="status">正在处理，请勿修改数据目录。关闭页面不会取消任务，重新打开可继续查看。</p>}
  </>}
 </main>;
}
