import { assertReleaseIntegrity } from './release.js';
import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { plan } from './planner.js';
import { preview } from './preview.js';
import { execute, recoverJobs, initializeData, baseline, restore, validateInitialization, hasOnlyInitializationTraces, type Initialization } from './runner.js';
import { present, safe, readJson } from './journal.js';
import { MigrationError, publicError, type Job } from './types.js';
interface Request { command:'check'|'plan'|'execute'|'recover'; root:string; original?:string[]; job?:Job; answers?:Record<string,unknown> }
if(parentPort)void(async()=>{
 const request=workerData as Request, {root}=request;
 const point=(name:string)=>parentPort!.postMessage({type:'boundary',name});
 try{
  assertReleaseIntegrity();
  if(request.command==='check'){
   const initialization=safe(root,'migrations/initialization.json');
   if(present(initialization)){
    const record=readJson<Initialization>(initialization);validateInitialization(record);
    if(record.phase!=='committed'){point('initialization:begin');initializeData(root,record.kind,record.id,point);}
   }
   if(!present(safe(root,'workbench.db'))){
    if(present(initialization)||!hasOnlyInitializationTraces(root))throw new MigrationError(present(safe(root,'orchard.db'))?'OLD_DATA_DIRECTORY':'INCOMPLETE_DATA_DIRECTORY');
    point('initialization:begin');initializeData(root,'new_install',randomUUID(),point);
   }
   const jobs=recoverJobs(root,point);
   if(jobs.some(j=>j.phase==='recovery_required'))parentPort.postMessage({type:'result',result:{jobs,recovery:true}});
   else{
    baseline(root);
    let current=await preview(root);
    if(current.steps.length===0){
     if(current.sourceVersions.webBridge===null){point('initialization:begin');initializeData(root,'optional_config',randomUUID(),point);}
     baseline(root);current=plan(root);
    }
    parentPort.postMessage({type:'result',result:{jobs,plan:current}});
   }
  }else if(request.command==='plan')parentPort!.postMessage({type:'result',result:await preview(root,request.answers)});
  else if(request.command==='execute')parentPort.postMessage({type:'result',result:execute(root,request.job!,point)});
  else parentPort.postMessage({type:'result',result:restore(root,request.job!,point)});
 }catch(error){parentPort!.postMessage({type:'error',error:publicError(error)});}
})();
