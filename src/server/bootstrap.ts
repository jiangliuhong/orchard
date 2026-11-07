import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DirectoryLease } from '../migrations/lock.js';
import { currentVersion } from '../migrations/frozen.js';
import { canonical, safe, present, durable, readJson, writeJson, removeDurable } from '../migrations/journal.js';
import { publishJob } from '../migrations/runner.js';
import { resolvePlan } from '../migrations/planner.js';
import { MigrationError, publicError, type State, type Status, type Plan, type Job, type Submission, type PublicError } from '../migrations/types.js';
interface Operation {formatVersion:1;requestId:string;scope:string;inputHmac:string;operationId:string;jobId?:string;accepted:boolean;result?:boolean}
export class Bootstrap {
 readonly lease:DirectoryLease;
 readonly token=randomBytes(32).toString('hex');
 readonly sessionId=randomUUID();
 private readonly signing=randomBytes(32);
 private privateKey!:Buffer;
 private state:State='checking';
 private revision=0;
 private error?:PublicError;
 private currentPlan?:Plan;
 private jobs=new Map<string,Job>();
 private activeJobId?:string;
 private initializationAttemptId?:string;
 private workers=new Set<Worker>();
 private planning?:Promise<Plan>;
 private planFailure?:PublicError;
 private workPromise?:Promise<unknown>;
 private dataInitializationPending=false;
 private chain:Promise<unknown>=Promise.resolve();
 private closing=false;
 private variants=new Map<string,string>();
 private confirmations=new Map<string,{planHash:string;answers:string;expiresAt:number}>();
 private initializeBusiness?:()=>Promise<void>;
 private activateBusiness?:()=>void;
 private checkPromise?:Promise<void>;
 constructor(root:string,readonly port:number){this.lease=DirectoryLease.acquire(root);}
 get root(){return this.lease.root;}
 get ready(){return this.state==='ready'&&!this.closing;}
 private transition(state:State,error?:PublicError){this.state=state;this.error=error;this.revision++;}
 status(privateView=false):Status {
  return {state:this.state,ready:this.ready,revision:this.revision,...(privateView?{activeJobId:this.activeJobId,initializationAttemptId:this.initializationAttemptId,actions:this.actions(),error:this.error,dataDir:this.root}:{})};
 }
 private actions(){return this.state==='migration_required'?['plan','validate','create']:this.state==='failed'?['plan','validate','retry']:this.state==='recovery_required'?['recover']:this.state==='initialization_failed'?['initialize']:[];}
 private serialize<T>(action:()=>Promise<T>):Promise<T>{const result=this.chain.then(action);this.chain=result.catch(()=>{});return result;}
 private run<T>(command:string,extra:Record<string,unknown>={}):Promise<T>{
  this.lease.assert();if(this.closing)return Promise.reject(new MigrationError('INVALID_STATE'));
  return new Promise((resolve,reject)=>{
   const js=new URL('../migrations/worker.js',import.meta.url);
   const options={workerData:{command,root:this.root,...extra}};
   const worker=present(fileURLToPath(js))?new Worker(js,options):new Worker(`require('tsx/cjs'); require(${JSON.stringify(fileURLToPath(new URL('../migrations/worker.ts',import.meta.url)))});`,{...options,eval:true});
   this.workers.add(worker);let settled=false;
   worker.on('message',message=>{
    if(message.type==='boundary'){
     if(String(message.name).startsWith('initialization:'))this.transition('initializing');
     if(this.activeJobId){try{const job=this.readJob(this.activeJobId);this.jobs.set(job.jobId,job);const phase=job.phase;const next:State=phase==='verifying'?'verifying':['installing','installed'].includes(phase)?'installing':phase==='restoring'?'restoring':this.state;if(next!==this.state)this.transition(next);else this.revision++;}catch{/* accepted state may not yet be on disk */}}
    }else if(message.type==='result'){settled=true;resolve(message.result as T);}
    else if(message.type==='error'){settled=true;reject(Object.assign(new MigrationError(message.error.code),{public:message.error}));}
   });
   worker.on('error',error=>{settled=true;reject(error);});
   worker.on('exit',()=>{this.workers.delete(worker);if(!settled)reject(new MigrationError('MIGRATION_FAILED'));});
  });
 }
 start(initialize:()=>Promise<void>,activate:()=>void=()=>{}){
  this.initializeBusiness=initialize;this.activateBusiness=activate;
  this.checkPromise=this.check();return this.checkPromise;
 }
 private async check(){
  try{
   this.lease.assert();
   const result=await this.run<{jobs:Job[];plan?:Plan;recovery?:boolean}>('check',{original:this.lease.original});
   for(const job of result.jobs)this.jobs.set(job.jobId,job);
   this.loadKey();this.reconcileOperations();
   if(result.recovery){const job=result.jobs.find(j=>j.phase==='recovery_required')!;this.activeJobId=job.jobId;this.transition('recovery_required',job.error);return;}
   this.currentPlan=result.plan;
   if(result.plan!.steps.length){const failed=result.jobs.findLast(j=>['failed','restored'].includes(j.phase));this.activeJobId=failed?.jobId;this.transition(failed?'failed':'migration_required',failed?.error);}
   else await this.initialize();
  }catch(error){
   if(this.closing)return;
   if(this.state==='initializing'){
    this.dataInitializationPending=true;
    try{this.loadKey();this.transition('initialization_failed',publicError(error));}catch(failure){this.transition('blocked',publicError(failure));}
   }else this.transition('blocked',publicError(error));
  }
 }
 private loadKey(){
  const path=safe(this.root,'migrations/private-key');
  if(!present(path)){
   if(this.jobs.size||(present(safe(this.root,'migrations/jobs'))&&readdirSync(safe(this.root,'migrations/jobs')).length)||present(safe(this.root,'migrations/operations')))throw new MigrationError('PRIVATE_KEY_MISSING');
   durable(path,randomBytes(32));
  }
  this.privateKey=readFileSync(path);if(this.privateKey.length!==32)throw new MigrationError('PRIVATE_KEY_MISSING');
 }
 private operationFiles(path:string){
  return readdirSync(path).filter(name=>{
   if(/^[a-f\d-]{36}\.json\.tmp-[a-f\d-]{36}$/.test(name)){
    const temporary=safe(path,name);if(!lstatSync(temporary).isFile())throw new MigrationError('UNKNOWN_PROTOCOL');removeDurable(temporary);return false;
   }
   if(!/^[a-f\d-]{36}\.json$/.test(name))throw new MigrationError('UNKNOWN_PROTOCOL');return true;
  });
 }
 private reconcileOperations(){
  const path=safe(this.root,'migrations/operations');if(!present(path))return;
  for(const name of this.operationFiles(path)){
   const operation=readJson<Operation>(safe(this.root,`migrations/operations/${name}`));
   if(operation.formatVersion!==1||!operation.accepted)throw new MigrationError('UNKNOWN_PROTOCOL');
   // Startup check already converges persisted recovery/data initialization attempts.
   if(!operation.result){operation.result=true;writeJson(safe(this.root,`migrations/operations/${name}`),operation);}
  }
 }
 private async initialize(){
  if(this.closing)return;
  this.transition('initializing');
  try{
   if(this.dataInitializationPending){await this.run('check',{original:this.lease.original});this.dataInitializationPending=false;}
   await this.initializeBusiness!();if(this.closing)return;this.transition('ready');this.activateBusiness?.();
   if(this.activeJobId){const job=this.jobs.get(this.activeJobId);if(job?.result){job.result.ready=true;job.revision++;writeJson(safe(this.root,`migrations/jobs/${job.jobId}/state.json`),job);}}
  }catch{this.transition('initialization_failed',publicError(new MigrationError('INITIALIZATION_FAILED')));}
 }
 private requestHash(scope:string,input:unknown){if(!this.privateKey)throw new MigrationError('PRIVATE_KEY_MISSING');return createHmac('sha256',this.privateKey).update(canonical({scope,input})).digest('hex');}
 private readJob(id:string){if(!/^[a-f\d-]{36}$/.test(id))throw new MigrationError('NOT_FOUND');const path=safe(this.root,`migrations/jobs/${id}/state.json`);if(!present(path))throw new MigrationError('NOT_FOUND');return readJson<Job>(path);}
 jobView(id:string){
  const job=this.readJob(id);return {jobId:job.jobId,attemptOf:job.attemptOf,phase:job.phase,revision:job.revision,steps:job.steps,processed:job.processed,startedAt:job.startedAt,updatedAt:job.updatedAt,result:job.result?{...job.result,ready:this.ready}:undefined,error:job.error,actions:job.phase==='recovery_required'?['recover']:['failed','restored'].includes(job.phase)?['retry']:[]};
 }
 getPlan(force=false):Promise<Plan>{
  if(!['migration_required','failed'].includes(this.state))return Promise.reject(new MigrationError('INVALID_STATE'));
  if(this.currentPlan&&!force)return Promise.resolve(this.currentPlan);
  if(!this.planning)this.planning=this.run<Plan>('plan').then(value=>{this.currentPlan=value;this.planFailure=undefined;return value;}).catch(error=>{this.currentPlan=undefined;this.planFailure=publicError(error);throw error;}).finally(()=>{this.planning=undefined;});
  return this.planning;
 }
 async validate(input:{planHash:string;answers:Record<string,unknown>}){
  let plan:Plan;try{plan=await this.getPlan(true);}catch(error){if(error instanceof MigrationError&&error.code==='INVALID_STATE')throw error;throw new MigrationError('PLAN_STALE');}
  if(plan.planHash!==input.planHash&&this.variants.get(input.planHash)!==plan.planHash)throw new MigrationError('PLAN_STALE');
  const checked=resolvePlan(plan,input.answers);this.variants.set(checked.plan.planHash,plan.planHash);plan=checked.plan;
  const summary=plan.steps.map(s=>({id:s.id,summary:s.summary}));
  if(Object.keys(checked.fieldErrors).length)throw Object.assign(new MigrationError('INVALID_ANSWERS'),{fieldErrors:checked.fieldErrors});
  if(plan.questions.length){const rehearsed=await this.run<Plan>('plan',{answers:checked.answers});if(rehearsed.planHash!==plan.planHash||rehearsed.status!=='ready')throw new MigrationError('PLAN_STALE');}
  for(const [key,value] of this.confirmations)if(value.expiresAt<Date.now())this.confirmations.delete(key);
  const expiresAt=Date.now()+30*60*1000;
  const confirmationHash=createHmac('sha256',this.signing).update(canonical({session:this.sessionId,planHash:plan.planHash,answers:checked.answers,summary,expiresAt})).digest('hex');
  this.confirmations.set(confirmationHash,{planHash:plan.planHash,answers:canonical(checked.answers),expiresAt});
  return {planHash:plan.planHash,summary,fieldErrors:{},confirmationHash,expiresAt:new Date(expiresAt).toISOString()};
 }
 submit(input:Submission,attemptOf?:string){return this.serialize(async()=>{
  const scope=attemptOf?`retry:${attemptOf}`:'jobs', inputHmac=this.requestHash(scope,{requestId:input.requestId,planHash:input.planHash,answers:input.answers});
  const receipt=[...this.jobs.values()].find(j=>j.requestScope===scope&&j.requestId===input.requestId);
  if(receipt){if(receipt.inputHmac!==inputHmac)throw new MigrationError('REQUEST_CONFLICT');return {jobId:receipt.jobId,state:receipt.phase,statusUrl:`/api/migrations/jobs/${receipt.jobId}`};}
  if(attemptOf&&!['failed','restored'].includes(this.readJob(attemptOf).phase))throw new MigrationError('INVALID_STATE');
  const active=[...this.jobs.values()].find(j=>!['committed','failed','restored'].includes(j.phase));
  if(active){if(active.plan.planHash===input.planHash&&active.inputHmac===this.requestHash(active.requestScope,{requestId:active.requestId,planHash:input.planHash,answers:input.answers}))return {jobId:active.jobId,state:active.phase,statusUrl:`/api/migrations/jobs/${active.jobId}`};throw new MigrationError('MIGRATION_BUSY');}
  let plan:Plan;try{plan=await this.getPlan(true);}catch(error){if(error instanceof MigrationError&&error.code==='INVALID_STATE')throw error;throw new MigrationError('PLAN_STALE');}
  const checked=resolvePlan(plan,input.answers);plan=checked.plan;
  if(plan.planHash!==input.planHash)throw new MigrationError('PLAN_STALE');
  if(Object.keys(checked.fieldErrors).length)throw Object.assign(new MigrationError('INVALID_ANSWERS'),{fieldErrors:checked.fieldErrors});
  const confirmation=this.confirmations.get(input.confirmationHash);
  if(!confirmation||confirmation.expiresAt<Date.now()||confirmation.planHash!==plan.planHash||confirmation.answers!==canonical(checked.answers))throw new MigrationError('CONFIRMATION_EXPIRED');
  const now=new Date().toISOString(),id=randomUUID();
  const ledgerPath=safe(this.root,'migrations/ledger.json');
  const job:Job={formatVersion:1,jobId:id,attemptOf,requestId:input.requestId,requestScope:scope,inputHmac,plan,phase:'accepted',revision:1,startedAt:now,updatedAt:now,steps:plan.steps.map(s=>({id:s.id,state:'pending'})),processed:0,install:[],ledgerBefore:present(ledgerPath)?readJson(ledgerPath):null};
  publishJob(this.root,job,checked.answers);this.confirmations.delete(input.confirmationHash);this.jobs.set(id,job);this.activeJobId=id;this.transition('migrating');
  // Accepted is durable before scheduling any worker or returning 202.
  setImmediate(()=>{if(!this.closing)this.workPromise=this.perform(job);});
  return {jobId:id,state:job.phase,statusUrl:`/api/migrations/jobs/${id}`};
 });}
 private async perform(job:Job,recover=false){
  try{
   const result=await this.run<Job>(recover?'recover':'execute',{job});this.jobs.set(result.jobId,result);
   if(result.phase==='committed')await this.initialize();
   else if(result.phase==='recovery_required')this.transition('recovery_required',result.error);
   else{this.currentPlan=await this.run<Plan>('plan');this.transition('failed',result.error);}
  }catch(error){
   if(this.closing)return;
   // A worker exit is reconciled from durable phases before any retry is allowed.
   this.transition('restoring');
   try{const result=await this.run<{jobs:Job[];recovery?:boolean;plan?:Plan}>('check');for(const j of result.jobs)this.jobs.set(j.jobId,j);this.currentPlan=result.plan;if(result.recovery)this.transition('recovery_required',publicError(error));else if(result.plan&&!result.plan.steps.length)await this.initialize();else this.transition('failed',publicError(error));}
   catch(failure){try{const durable=this.readJob(job.jobId);this.jobs.set(durable.jobId,durable);}catch{/* An unreadable journal cannot authorize recovery. */}this.currentPlan=undefined;this.transition(this.jobs.get(job.jobId)?.phase==='failed'?'blocked':'recovery_required',publicError(failure));}
  }
 }
 operation(scope:string,requestId:string,jobId?:string){return this.serialize(async()=>{
  const input={requestId},inputHmac=this.requestHash(scope,input),path=safe(this.root,'migrations/operations');
  if(present(path))for(const file of this.operationFiles(path)){
   const previous=readJson<Operation>(safe(this.root,`migrations/operations/${file}`));
   if(previous.scope===scope&&previous.requestId===requestId){if(previous.inputHmac!==inputHmac)throw new MigrationError('REQUEST_CONFLICT');return jobId?{jobId,recoveryAttemptId:previous.operationId}:{initializationAttemptId:previous.operationId};}
  }
  const existing=present(path)?this.operationFiles(path).map(file=>readJson<Operation>(safe(this.root,`migrations/operations/${file}`))).find(o=>o.scope===scope&&!o.result):undefined;
  if(existing&&['restoring','initializing'].includes(this.state))return jobId?{jobId,recoveryAttemptId:existing.operationId}:{initializationAttemptId:existing.operationId};
  if(jobId){if(this.state!=='recovery_required'||this.readJob(jobId).phase!=='recovery_required')throw new MigrationError('INVALID_STATE');}
  else if(this.state!=='initialization_failed')throw new MigrationError('INVALID_STATE');
  if(existing){existing.result=true;writeJson(safe(this.root,`migrations/operations/${existing.operationId}.json`),existing);}
  const operation:Operation={formatVersion:1,operationId:randomUUID(),requestId,scope,inputHmac,jobId,accepted:true};const record=safe(this.root,`migrations/operations/${operation.operationId}.json`);writeJson(record,operation);
  if(jobId)this.transition('restoring');else{this.initializationAttemptId=operation.operationId;this.transition('initializing');}
  setImmediate(()=>{if(this.closing)return;this.workPromise=(jobId?this.perform(this.readJob(jobId),true):this.initialize()).finally(()=>{if(this.closing)return;operation.result=true;try{writeJson(record,operation);}catch(error){this.error=publicError(error);this.revision++;}});});
  return jobId?{jobId,recoveryAttemptId:operation.operationId}:{initializationAttemptId:operation.operationId};
 });}
 private authenticated(request:FastifyRequest){const supplied=request.headers['x-orchard-bootstrap-token'];return typeof supplied==='string'&&/^[a-f\d]{64}$/.test(supplied)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(this.token));}
 register(app:FastifyInstance){
  app.addHook('onRequest',async(request,reply)=>{
   const host=request.headers.host??'',port=request.socket.localPort??this.port;
   const allowed=['127.0.0.1','localhost','[::1]'].some(name=>host===`${name}:${port}`||(port===80&&host===name));
   if(!allowed)return reply.code(403).send(publicError(new MigrationError('INVALID_HOST')));
   const expected=`http://${host}`,origin=request.headers.origin,site=request.headers['sec-fetch-site'];
   if(origin!==undefined&&origin!==expected||site!==undefined&&!['same-origin','none'].includes(site)||site==='none'&&request.method!=='GET')return reply.code(403).send(publicError(new MigrationError('INVALID_ORIGIN')));
   if(request.method==='OPTIONS')return reply.code(403).send(publicError(new MigrationError('INVALID_ORIGIN')));
   const url=request.url.split('?')[0], protectedPath=url.startsWith('/api/migrations/')||url==='/api/migrations/plan'||url==='/api/bootstrap/initialize';
   if(protectedPath&&!this.authenticated(request))return reply.code(401).send(publicError(new MigrationError('UNAUTHORIZED')));
   if(protectedPath&&request.method==='POST'&&(origin!==expected||!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type']??''))))return reply.code(403).send(publicError(new MigrationError('INVALID_ORIGIN')));
   reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
  });
  const handle=async(fn:()=>unknown,reply:any)=>{try{return await fn();}catch(error){const body=publicError(error);const code=body.code;return reply.code(code==='UNAUTHORIZED'?401:code==='NOT_FOUND'?404:code==='INVALID_REQUEST'?400:code==='INVALID_ANSWERS'?422:409).send(body);}};
  const input=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))throw new MigrationError('INVALID_REQUEST');return value as Record<string,unknown>;};
  const identifier=(value:unknown)=>{if(typeof value!=='string'||value.length<1||value.length>200)throw new MigrationError('INVALID_REQUEST');return value;};
  const submission=(value:unknown):Submission=>{const body=input(value,['requestId','planHash','confirmationHash','answers']);if(!body.answers||typeof body.answers!=='object'||Array.isArray(body.answers))throw new MigrationError('INVALID_REQUEST');return {requestId:identifier(body.requestId),planHash:identifier(body.planHash),confirmationHash:identifier(body.confirmationHash),answers:body.answers as Record<string,unknown>};};
  app.get('/api/bootstrap/session',async(request,reply)=>{
   const origin=`http://${request.headers.host}`;
   if(request.headers['x-orchard-bootstrap']!=='1'||(request.headers['sec-fetch-site']!=='same-origin'&&request.headers.origin!==origin))return reply.code(403).send(publicError(new MigrationError('INVALID_ORIGIN')));
   reply.header('Cache-Control','no-store');return {token:this.token,sessionId:this.sessionId};
  });
  app.get('/api/bootstrap/status',async(request,reply)=>{reply.header('Cache-Control','no-store');return this.status(this.authenticated(request));});
  app.get('/api/health',async()=>({ok:true,ready:this.ready,application:'orchard-workbench',schemaVersion:currentVersion}));
  app.get('/api/ready',async(_request,reply)=>reply.code(this.ready?200:503).send({ready:this.ready}));
  app.get('/api/migrations/plan',async(_request,reply)=>{
   if(!['migration_required','failed'].includes(this.state))return handle(()=>{throw new MigrationError('INVALID_STATE');},reply);
   if(!this.planning&&!this.currentPlan){void this.getPlan().catch(error=>{this.error=publicError(error);this.revision++;});}
   if(this.planFailure)return {status:'blocked',blockers:[this.planFailure],revision:this.revision};
   if(!this.currentPlan)return reply.code(202).send({status:'checking',revision:this.revision,retryAfterMs:1000});
   return this.currentPlan;
  });
  app.post('/api/migrations/validate',async(request,reply)=>handle(async()=>{const body=input(request.body,['planHash','answers']);if(!body.answers||typeof body.answers!=='object'||Array.isArray(body.answers))throw new MigrationError('INVALID_REQUEST');const result=await this.validate({planHash:identifier(body.planHash),answers:body.answers as Record<string,unknown>});if(Object.keys(result.fieldErrors).length)reply.code(422);return result;},reply));
  app.post('/api/migrations/jobs',async(request,reply)=>handle(async()=>{const result=await this.submit(submission(request.body));reply.code(202);return result;},reply));
  app.get<{Params:{jobId:string}}>('/api/migrations/jobs/:jobId',async(request,reply)=>handle(()=>this.jobView(request.params.jobId),reply));
  app.post<{Params:{jobId:string}}>('/api/migrations/jobs/:jobId/retry',async(request,reply)=>handle(async()=>{const result=await this.submit(submission(request.body),request.params.jobId);reply.code(202);return result;},reply));
  app.post<{Params:{jobId:string}}>('/api/migrations/jobs/:jobId/recover',async(request,reply)=>handle(async()=>{const body=input(request.body,['requestId']);const result=await this.operation(`recover:${request.params.jobId}`,identifier(body.requestId),request.params.jobId);reply.code(202);return result;},reply));
  app.post('/api/bootstrap/initialize',async(request,reply)=>handle(async()=>{const body=input(request.body,['requestId']);const result=await this.operation('initialize',identifier(body.requestId));reply.code(202);return result;},reply));
  app.get<{Params:{jobId:string}}>('/api/migrations/jobs/:jobId/report',async(request,reply)=>handle(()=>{const job=this.readJob(request.params.jobId);reply.header('Content-Disposition',`attachment; filename="migration-${job.jobId}.json"`);return {formatVersion:1,jobId:job.jobId,phase:job.phase,migrations:job.plan.steps.map(s=>({id:s.id,checksum:s.checksum})),processed:job.processed,error:job.error,externalSessions:'目录外会话仅保留引用，不属于自动备份范围。'};},reply));
 }
 async close(){
  this.closing=true;this.revision++;
  await Promise.all([...this.workers].map(worker=>worker.terminate()));
  await this.chain.catch(()=>{});
  await this.checkPromise?.catch(()=>{});
  await this.workPromise?.catch(()=>{});
 }
 release(){this.lease.release();}
}
