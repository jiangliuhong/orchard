import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, chmodSync, lstatSync, statfsSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { declarations, initializationSql, currentVersion } from './frozen.js';
import { defaultBridgeConfig, validateBridgeConfigV1 } from './config.js';
import { applyDefinitions } from './definitions.js';
import { plan, source, validateLedger, resolvePlan } from './planner.js';
import { verifyDatabase } from './validators.js';
import { captureRows, verifyMapping } from './mapping.js';
import { safe, present, readJson, writeJson, directory, scan, copyDurable, canonical, fileHash, syncDirectory, removeDurable, durable, appendJson } from './journal.js';
import { resourceRoots, MigrationError, publicError, type Job, type Snapshot, type Ledger, type Plan } from './types.js';
export type Boundary = (name:string)=>void;
const noop:Boundary=()=>{};
const jobPath=(root:string,id:string)=>safe(root,`migrations/jobs/${id}/state.json`);
export function saveJob(root:string,job:Job,point:Boundary=noop){
  job.revision++;job.updatedAt=new Date().toISOString();point(`state:${job.phase}:before`);writeJson(jobPath(root,job.jobId),job);
  try{appendJson(safe(root,`migrations/jobs/${job.jobId}/events.jsonl`),{formatVersion:1,revision:job.revision,phase:job.phase,processed:job.processed,time:job.updatedAt});}catch{/* Diagnostic events never override authoritative state or prevent recovery. */}
  point(`state:${job.phase}:after`);
}
export function publishJob(root:string,job:Job,answers:Record<string,unknown>,point:Boundary=noop){
  const staging=safe(root,`migrations/accepting/${job.jobId}`);directory(staging);
  point('acceptance:state:before');writeJson(safe(staging,'state.json'),job);point('acceptance:state:after');
  if(Object.keys(answers).length){point('acceptance:input:before');writeJson(safe(staging,'private-input.json'),answers);point('acceptance:input:after');}
  directory(safe(root,'migrations/jobs'));point('acceptance:publish:before');renameSync(staging,safe(root,`migrations/jobs/${job.jobId}`));syncDirectory(safe(root,'migrations/jobs'));syncDirectory(safe(root,'migrations/accepting'));point('acceptance:publish:after');
}
function clearUnpublishedJobs(root:string){
  const staging=safe(root,'migrations/accepting');if(!present(staging))return;
  for(const id of readdirSync(staging)){
    if(!/^[a-f\d-]{36}$/.test(id))throw new MigrationError('UNKNOWN_PROTOCOL');const path=safe(staging,id);if(!lstatSync(path).isDirectory())throw new MigrationError('UNKNOWN_PROTOCOL');
    for(const file of readdirSync(path))if(!/^(state\.json|private-input\.json)(\.tmp-[a-f\d-]{36})?$/.test(file)||!lstatSync(safe(path,file)).isFile())throw new MigrationError('UNKNOWN_PROTOCOL');
    rmSync(path,{recursive:true});syncDirectory(staging);
  }
}
function stage(root:string,job:Job,phase:Job['phase'],point:Boundary){job.phase=phase;saveJob(root,job,point);}
function snapshotPath(root:string,id:string){return safe(root,`backups/migrations/${id}/snapshot`);}
function loadSnapshot(root:string,job:Job):Snapshot {
  const snapshot=readJson<Snapshot>(safe(root,`backups/migrations/${job.jobId}/manifest.json`));
  if(snapshot.formatVersion!==1||!Array.isArray(snapshot.files)||!Array.isArray(snapshot.missing)||snapshot.fingerprint!==job.plan.sourceFingerprint)throw new MigrationError('BACKUP_CORRUPT');
  const actual=scan(snapshotPath(root,job.jobId),resourceRoots);
  if(canonical(actual)!==canonical({files:snapshot.files,missing:snapshot.missing}))throw new MigrationError('BACKUP_CORRUPT');
  return snapshot;
}
function checkpoint(path:string){
  const db=new DatabaseSync(path);try{const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!;if(Number(result.busy)!==0)throw new MigrationError('MIGRATION_BUSY');}finally{db.close();}
  if(present(path+'-wal')||present(path+'-shm'))throw new MigrationError('MIGRATION_BUSY');
}
function ensureOriginal(root:string,job:Job){if(source(root).fingerprint!==job.plan.sourceFingerprint)throw new MigrationError('SOURCE_CHANGED');}
export function backup(root:string,job:Job,point:Boundary=noop){
  stage(root,job,'backing_up',point);ensureOriginal(root,job);
  const fs=statfsSync(root);if(Number(fs.bavail)*Number(fs.bsize)<job.plan.estimates.requiredBytes)throw new MigrationError('INSUFFICIENT_SPACE');
  checkpoint(safe(root,'workbench.db'));
  const before=scan(root,resourceRoots), target=snapshotPath(root,job.jobId);directory(target);
  for(const file of before.files){
    point(`backup:${file.path}:before`);
    const path=safe(target,file.path);
    if(file.type==='directory')directory(path);else copyDurable(safe(root,file.path),path,file.mode);
    job.processed++;saveJob(root,job);point(`backup:${file.path}:after`);
  }
  for(const file of [...before.files].reverse())if(file.type==='directory'){const path=safe(target,file.path);chmodSync(path,file.mode);syncDirectory(path);}
  const after=scan(root,resourceRoots);
  if(canonical(before)!==canonical(after))throw new MigrationError('SOURCE_CHANGED');
  ensureOriginal(root,job);
  const manifest:Snapshot={formatVersion:1,...before,fingerprint:job.plan.sourceFingerprint};
  writeJson(safe(root,`backups/migrations/${job.jobId}/manifest.json`),manifest);loadSnapshot(root,job);
  stage(root,job,'backup_complete',point);
}
function copySnapshot(root:string,job:Job){
  const snapshot=loadSnapshot(root,job), work=safe(root,`runtime/migrations/${job.jobId}/work`);directory(work);
  for(const file of snapshot.files){const target=safe(work,file.path);if(file.type==='directory')directory(target);else copyDurable(safe(snapshotPath(root,job.jobId),file.path),target,file.mode);}
  chmodSync(safe(work,'workbench.db'),0o600);
  return work;
}
function transform(root:string,job:Job,answers:Readonly<Record<string,unknown>>,point:Boundary){
  const work=copySnapshot(root,job);stage(root,job,'transforming',point);
  const db=new DatabaseSync(safe(work,'workbench.db'));
  try{
    const initial=verifyDatabase(db,work,root);
    const before=captureRows(db);
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try{
      applyDefinitions({database:db,root:work,sourceRoot:root,answers},job.plan.steps,definition=>{
        point(`transform:${definition.id}:after`);
        const step=job.steps.find(value=>value.id===definition.id);if(step)step.state='complete';saveJob(root,job);
      });
      verifyMapping(db,before,initial);
      verifyDatabase(db,work,root);db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
  const config=safe(work,'config/web-bridge.json');
  if(!present(config))writeJson(config,defaultBridgeConfig());
  point('transform:config.web-bridge:after');
  for(const step of job.steps)step.state='complete';
  stage(root,job,'verifying',point);
  const verification=new DatabaseSync(safe(work,'workbench.db'),{readOnly:true});try{verifyDatabase(verification,work,root);}finally{verification.close();}
  validateBridgeConfigV1(readFileSync(config,'utf8'));checkpoint(safe(work,'workbench.db'));
  return work;
}
export function restore(root:string,job:Job,point:Boundary=noop){
  try{
    stage(root,job,'restoring',point);
    const snapshot=loadSnapshot(root,job);
    const disk=readJson<{formatVersion:number;items:Job['install']}>(safe(root,`migrations/jobs/${job.jobId}/install.json`));
    const resources=[...new Set(job.plan.steps.flatMap(step=>{const definition=declarations.find(value=>value.id===step.id&&value.checksum===step.checksum);if(!definition)throw new MigrationError('UNKNOWN_PROTOCOL');return definition.affectedResources;}))];
    if(job.plan.sourceVersions.webBridge===null&&job.plan.steps.length)resources.push('config/web-bridge.json');
    if(canonical([...job.plan.resources].sort())!==canonical(resources.sort())||canonical(job.install.map(item=>item.path))!==canonical(job.plan.resources)||job.install.some(item=>item.before!==(snapshot.files.find(file=>file.path===item.path)?.hash??null)||!/^[a-f\d]{64}$/.test(item.target)))throw new MigrationError('UNKNOWN_PROTOCOL');
    if(disk.formatVersion!==1||!Array.isArray(disk.items)||canonical(disk.items.map(({path,before,target})=>({path,before,target})))!==canonical(job.install.map(({path,before,target})=>({path,before,target}))))throw new MigrationError('UNKNOWN_PROTOCOL');
    // Validate every resource before writing any. Unmodified resources must also be unchanged.
    const originalSnapshot=snapshotPath(root,job.jobId);
    const formal=scan(root,resourceRoots.filter(r=>r!=='workbench.db'));
    const expected=snapshot.files.filter(f=>f.path!=='workbench.db'&&!job.install.some(item=>item.path===f.path));
    const observed=formal.files.filter(f=>!job.install.some(item=>item.path===f.path));
    // Optional config may have introduced its parent directory; its contents are still controlled.
    const filter=(files:typeof expected)=>files.filter(f=>!(f.path==='config'&&!snapshot.files.some(s=>s.path==='config')));
    if(canonical(filter(expected))!==canonical(filter(observed)))throw new MigrationError('RECOVERY_CONFLICT');
    for(const item of job.install){const path=safe(root,item.path),actual=fileHash(path);if(actual!==item.before&&actual!==item.target)throw new MigrationError('RECOVERY_CONFLICT');
      const mode=snapshot.files.find(file=>file.path===item.path)?.mode??0o600;
      if(actual!==null&&(lstatSync(path).mode&0o7777)!==mode)throw new MigrationError('RECOVERY_CONFLICT');
    }
    const ledger=safe(root,'migrations/ledger.json');
    if(present(ledger)){
      const current=readJson<Ledger>(ledger), before=job.ledgerBefore as Ledger|null;
      if(canonical(current)!==canonical(before)&&(!current.completed?.some(c=>c.jobId===job.jobId)||canonical({...current,completed:current.completed.filter(c=>c.jobId!==job.jobId)})!==canonical(before)))throw new MigrationError('RECOVERY_CONFLICT');
    }
    for(const item of job.install){
      point(`restore:${item.path}:before`);
      const path=safe(root,item.path);
      if(item.path==='workbench.db')for(const suffix of ['-wal','-shm']){const wal=safe(root,item.path+suffix);if(present(wal))throw new MigrationError('RECOVERY_CONFLICT');}
      if(item.before===null)removeDurable(path);
      else{
        const temp=safe(root,`${item.path}.restore-${job.jobId}`);copyDurable(safe(originalSnapshot,item.path),temp,snapshot.files.find(f=>f.path===item.path)!.mode);
        if(fileHash(temp)!==item.before)throw new MigrationError('BACKUP_CORRUPT');
        renameSync(temp,path);syncDirectory(dirname(path));
      }
      item.restored=true;saveJob(root,job);point(`restore:${item.path}:after`);
    }
    if(!snapshot.files.some(f=>f.path==='config')&&present(safe(root,'config'))&&readdirSync(safe(root,'config')).length===0){rmdirSync(safe(root,'config'));syncDirectory(root);}
    if(job.ledgerBefore===null)removeDurable(ledger);else writeJson(ledger,job.ledgerBefore);
    ensureOriginal(root,job);stage(root,job,'restored',point);removeDurable(safe(root,`migrations/jobs/${job.jobId}/private-input.json`));
  }catch(error){job.error=publicError(error);stage(root,job,'recovery_required',point);}
  return job;
}
export function execute(root:string,job:Job,point:Boundary=noop){
  try{
    const input=safe(root,`migrations/jobs/${job.jobId}/private-input.json`),answers=present(input)?readJson<Record<string,unknown>>(input):{};
    const current=resolvePlan(plan(root),answers);
    if(current.plan.planHash!==job.plan.planHash)throw new MigrationError('PLAN_STALE');
    if(Object.keys(current.fieldErrors).length)throw Object.assign(new MigrationError('INVALID_ANSWERS'),{fieldErrors:current.fieldErrors});
    backup(root,job,point);const work=transform(root,job,Object.freeze(current.answers),point);ensureOriginal(root,job);
    const snapshot=loadSnapshot(root,job);
    for(const relative of job.plan.resources){
      const target=safe(work,relative), temp=safe(root,`runtime/migrations/${job.jobId}/install/${relative}`);
      const before=snapshot.files.find(f=>f.path===relative);
      copyDurable(target,temp,before?.mode??0o600);
      job.install.push({path:relative,before:before?.hash??null,target:fileHash(temp)!});
    }
    writeJson(safe(root,`migrations/jobs/${job.jobId}/install.json`),{formatVersion:1,items:job.install});
    stage(root,job,'prepared',point);ensureOriginal(root,job);
    stage(root,job,'installing',point);
    for(const item of job.install){
      point(`install:${item.path}:before`);const path=safe(root,item.path);
      if(fileHash(path)!==item.before)throw new MigrationError('RECOVERY_CONFLICT');
      directory(dirname(path));renameSync(safe(root,`runtime/migrations/${job.jobId}/install/${item.path}`),path);syncDirectory(dirname(path));item.installed=true;saveJob(root,job);point(`install:${item.path}:after`);
    }
    const installed=source(root);if(installed.database!==currentVersion||installed.webBridge!==1)throw new MigrationError('DATABASE_CORRUPT');
    stage(root,job,'installed',point);
    const baseline=(job.ledgerBefore as Ledger|null)??{formatVersion:1,baseline:{...job.plan.sourceVersions,applicationId:1331110449,source:'verified historical workbench'},completed:[]};
    const ledger:Ledger={...baseline,completed:[...baseline.completed,{jobId:job.jobId,migrations:job.plan.steps,source:job.plan.sourceVersions,target:job.plan.targetVersions}]};
    point('ledger:before');writeJson(safe(root,'migrations/ledger.json'),ledger);point('ledger:after');
    job.result={committed:true,ready:false,backup:`backups/migrations/${job.jobId}`,bytes:snapshot.files.reduce((n,f)=>n+f.size,0)};
    stage(root,job,'committed',point);removeDurable(safe(root,`migrations/jobs/${job.jobId}/private-input.json`));
  }catch(error){
    // The commit marker may already be durable. Reconcile from disk before allowing business startup.
    if(job.phase==='committed')throw error;
    job.error=publicError(error);
    if(['installing','installed'].includes(job.phase))restore(root,job,point);
    else{try{ensureOriginal(root,job);}catch(changed){job.error=publicError(changed);}stage(root,job,'failed',point);}
  }
  if(['committed','failed','restored'].includes(job.phase))removeDurable(safe(root,`migrations/jobs/${job.jobId}/private-input.json`));
  return job;
}
export interface Initialization {formatVersion:1;kind:'new_install'|'optional_config';phase:'preparing'|'prepared'|'installing'|'committed';id:string;resources:{path:string;before:null;hash:string;installed:boolean}[]}
export function validateInitialization(record:Initialization){
  if(record.formatVersion!==1||!['new_install','optional_config'].includes(record.kind)||!['preparing','prepared','installing','committed'].includes(record.phase)||!/^[a-f\d-]{36}$/.test(record.id)||!Array.isArray(record.resources))throw new MigrationError('UNKNOWN_PROTOCOL');
  const expected=record.kind==='new_install'?['workbench.db','config/web-bridge.json']:['config/web-bridge.json'];
  if(record.phase==='preparing'?record.resources.length!==0:(canonical(record.resources.map(item=>item.path))!==canonical(expected)||record.resources.some(item=>item.before!==null||!/^[a-f\d]{64}$/.test(item.hash)||typeof item.installed!=='boolean')))throw new MigrationError('UNKNOWN_PROTOCOL');
}
export function hasOnlyInitializationTraces(root:string){
  if(readdirSync(root).some(name=>!['workbench.lock','migrations','runtime'].includes(name)))return false;
  const migrations=safe(root,'migrations');
  if(present(migrations)&&(!lstatSync(migrations).isDirectory()||readdirSync(migrations).some(name=>!/^initialization\.json\.tmp-[a-f\d-]{36}$/.test(name)||!lstatSync(safe(migrations,name)).isFile())))return false;
  const runtime=safe(root,'runtime');if(!present(runtime))return true;
  if(!lstatSync(runtime).isDirectory()||readdirSync(runtime).some(name=>name!=='initialization'))return false;
  const initialization=safe(runtime,'initialization');if(!present(initialization))return true;
  return lstatSync(initialization).isDirectory()&&readdirSync(initialization).every(id=>{
    if(!/^[a-f\d-]{36}$/.test(id))return false;const path=safe(initialization,id);return lstatSync(path).isDirectory()&&readdirSync(path).length===0;
  });
}
export function initializeData(root:string,kind:Initialization['kind'],id:string,point:Boundary=noop){
  const recordPath=safe(root,'migrations/initialization.json');
  let record:Initialization=present(recordPath)?readJson(recordPath):{formatVersion:1,kind,phase:'preparing',id,resources:[]};
  validateInitialization(record);
  if(record.phase==='committed'){
    if(kind==='optional_config'&&!present(safe(root,'config/web-bridge.json')))record={formatVersion:1,kind,phase:'preparing',id,resources:[]};
    else return;
  }
  const work=safe(root,`runtime/initialization/${record.id}`);
  if(record.phase==='preparing'){
    writeJson(recordPath,record);point('initialization:preparing');directory(work);
    const resources=record.kind==='new_install'?['workbench.db','config/web-bridge.json']:['config/web-bridge.json'];
    for(const relative of resources)if(present(safe(root,relative)))throw new MigrationError('RECOVERY_CONFLICT');
    if(record.kind==='new_install'){
      const path=safe(work,'workbench.db');rmSync(path,{force:true});const db=new DatabaseSync(path);try{db.exec(initializationSql);verifyDatabase(db);}finally{db.close();}chmodSync(path,0o600);checkpoint(path);
    }
    writeJson(safe(work,'config/web-bridge.json'),defaultBridgeConfig());
    record.resources=resources.map(path=>({path,before:null,hash:fileHash(safe(work,path))!,installed:false}));
    for(const item of record.resources)copyDurable(safe(work,item.path),safe(root,`${item.path}.initialize-${record.id}`));
    record.phase='prepared';writeJson(recordPath,record);point('initialization:prepared');
  }
  record.phase='installing';writeJson(recordPath,record);point('initialization:installing');
  for(const item of record.resources){
    const target=safe(root,item.path),actual=fileHash(target);
    if(actual!==null&&actual!==item.hash)throw new MigrationError('RECOVERY_CONFLICT');
    if(actual===null){const temp=safe(root,`${item.path}.initialize-${record.id}`);if(fileHash(temp)!==item.hash)throw new MigrationError('RECOVERY_CONFLICT');renameSync(temp,target);syncDirectory(dirname(target));}
    item.installed=true;writeJson(recordPath,record);point(`initialization:${item.path}:after`);
  }
  record.phase='committed';writeJson(recordPath,record);point('initialization:committed');
}
export function recoverJobs(root:string,point:Boundary=noop):Job[]{
  clearUnpublishedJobs(root);
  const path=safe(root,'migrations/jobs');if(!present(path))return[];
  const jobs=readdirSync(path).map(id=>{if(!/^[\da-f-]{36}$/.test(id))throw new MigrationError('UNKNOWN_PROTOCOL');const job=readJson<Job>(jobPath(root,id));if(job.formatVersion!==1||job.jobId!==id||!['accepted','backing_up','backup_complete','transforming','verifying','prepared','installing','installed','committed','failed','restoring','restored','recovery_required'].includes(job.phase))throw new MigrationError('UNKNOWN_PROTOCOL');return job;}).sort((a,b)=>a.startedAt.localeCompare(b.startedAt));
  for(const job of jobs){
    if(['installing','installed','restoring','recovery_required'].includes(job.phase))restore(root,job,point);
    else if(!['committed','failed','restored'].includes(job.phase)){
      job.error=publicError(new MigrationError('MIGRATION_FAILED','上次进程中断，请重新预览并确认'));
      try{ensureOriginal(root,job);}catch(error){job.error=publicError(error);}stage(root,job,'failed',point);
    }
    if(['committed','restored','failed'].includes(job.phase))removeDurable(safe(root,`migrations/jobs/${job.jobId}/private-input.json`));
  }
  const ledgerPath=safe(root,'migrations/ledger.json');
  if(!present(ledgerPath)&&jobs.length){
    if(jobs.some(j=>j.phase!=='committed'))throw new MigrationError('LEDGER_MISMATCH');
    let ledger=jobs[0].ledgerBefore as Ledger|null;
    if(!ledger)ledger={formatVersion:1,baseline:{...jobs[0].plan.sourceVersions,applicationId:1331110449,source:'reconstructed from committed jobs'},completed:[]};
    for(const job of jobs)if(!ledger.completed.some(j=>j.jobId===job.jobId))ledger.completed.push({jobId:job.jobId,migrations:job.plan.steps,source:job.plan.sourceVersions,target:job.plan.targetVersions});
    writeJson(ledgerPath,ledger);
  }
  return jobs;
}
export function baseline(root:string){const current=source(root);if(!validateLedger(root,current))writeJson(safe(root,'migrations/ledger.json'),{formatVersion:1,baseline:{database:current.database,webBridge:current.webBridge,applicationId:1331110449,source:'verified baseline'},completed:[]});}
