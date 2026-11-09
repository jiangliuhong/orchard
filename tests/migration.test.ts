import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DirectoryLease } from '../src/migrations/lock.js';
import { Bootstrap } from '../src/server/bootstrap.js';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/persistence/store.js';
import { FileStore } from '../src/persistence/files.js';
import { declarations, currentVersion } from '../src/migrations/frozen.js';
import { questions as testQuestions } from './fixtures/migrations/question-migration.js';
import { questionActive } from '../src/migrations/questions.js';
import { source, plan, validateLedger, validateAnswers, resolvePlan } from '../src/migrations/planner.js';
import { preview } from '../src/migrations/preview.js';
import { execute, recoverJobs, initializeData, restore, baseline } from '../src/migrations/runner.js';
import { defaultBridgeConfig } from '../src/migrations/config.js';
import { databaseFingerprint } from '../src/migrations/validators.js';
import { safe, present, scan, writeJson, readJson, durable, canonical, directory } from '../src/migrations/journal.js';
import type { Job, Ledger, Question } from '../src/migrations/types.js';
import { exampleFiles, until } from './helpers.js';
const cleanup=new Map<string,(()=>unknown|Promise<unknown>)[]>();
function rootFor(t:TestContext){const root=mkdtempSync(join(tmpdir(),'orchard-migration-'));cleanup.set(root,[]);t.after(async()=>{for(const close of cleanup.get(root)!.reverse())await close();rmSync(root,{recursive:true,force:true});cleanup.delete(root);});return root;}
function fixture(t:TestContext,version=2,config:0|1|null=0){
 const root=rootFor(t),db=new DatabaseSync(join(root,'workbench.db'));
 db.exec(readFileSync(new URL(`./fixtures/migrations/database/v${version}.sql`,import.meta.url),'utf8'));
 const files=new FileStore(root),tree=files.saveTree(exampleFiles('workflow'));
 db.prepare("INSERT INTO provider_settings VALUES('p',1,'{}','[]','model',1,0)").run();
 db.prepare("INSERT INTO workflows(id,name,created_at,updated_at) VALUES('workflow','flow',0,0)").run();
 db.prepare("INSERT INTO workflow_versions(id,workflow_id,version_no,definition_json,layout_json,artifact_path,content_hash,created_at) VALUES('version','workflow',1,?,'{}',?,?,0)").run(exampleFiles('workflow')['workflow.json'],tree.path,tree.hash);
 db.prepare("UPDATE workflows SET current_version_id='version' WHERE id='workflow'").run();
 db.prepare("INSERT INTO drafts(id,revision,artifact_path,validation_json,status,created_at,updated_at) VALUES('draft',0,?,'{}','draft',0,0)").run(tree.path);
 db.prepare("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('run','version','queued','{}',0)").run();
 db.prepare("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES('node','run','a','shell','pending')").run();
 db.prepare("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,started_at) VALUES('attempt','node',1,'succeeded','{}',0)").run();
 const blob=files.writeBlob({payload:'kept'});db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,0)').run(blob.id,blob.relativePath,blob.hash,blob.size,'application/json');
 db.prepare("INSERT INTO stream_events(stream_type,stream_id,sequence,event_type,payload_ref,created_at) VALUES('run','run',1,'run.queued',?,0)").run(JSON.stringify({artifactId:blob.id}));
 db.prepare("INSERT INTO command_receipts VALUES('scope','request','digest','{}',0)").run();
 if(version>=3){
  for(const status of ['current',version===3?'archived':'idle']){
   db.prepare(`INSERT INTO agent_conversations(id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,transport,connection_fingerprint,created_at,updated_at) VALUES(?,'draft','single','isolated',?,'p',1,'model',?,'fingerprint',0,12)`).run(status,status,version>=7?'native':'legacy');
  }
 }
 if(version>=5){
  const script=files.saveScriptTree({'main.mjs':'export default () => 1'});
  db.prepare("INSERT INTO scripts(id,name,description,runtime,status,created_at,updated_at) VALUES('script','safe','','nodejs','draft',0,0)").run();
  db.prepare("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at) VALUES('sv','script',1,'draft',0,'main.mjs','{}','{}',?,?,'{}',0,0)").run(script.path,script.hash);
  db.exec("UPDATE scripts SET current_draft_version_id='sv'");
 }
 db.close();
 if(config!==null)writeJson(safe(root,'config/web-bridge.json'),config===0?{applications:{demo:{id:'demo',name:'Demo',enabled:true}},environments:{demo:[{id:'prod',origin:'https://example.test',enabled:true,bound:false,tabAvailable:false}]},unknown:{nested:['keep',null]}}:{...defaultBridgeConfig(),unknown:{nested:['keep',null]}});
 for(const name of ['runs','script-agent','agent-sessions','agent-workspaces'])durable(safe(root,`${name}/fixture/opaque.dat`),Buffer.from([0,1,255,10]));
 return root;
}
function accept(root:string):Job{
 baseline(root);
 const p=plan(root),now=new Date().toISOString(),id=randomUUID();
 if(!present(safe(root,'migrations/private-key')))durable(safe(root,'migrations/private-key'),randomBytes(32));
 const ledger=safe(root,'migrations/ledger.json');
 const job:Job={formatVersion:1,jobId:id,requestScope:'test',requestId:id,inputHmac:'test-only',plan:p,phase:'accepted',revision:1,startedAt:now,updatedAt:now,steps:p.steps.map(s=>({id:s.id,state:'pending'})),processed:0,install:[],ledgerBefore:present(ledger)?readJson(ledger):null};
 writeJson(safe(root,`migrations/jobs/${id}/state.json`),job);return job;
}
async function boot(root:string,initialization?:()=>Promise<void>){
 const bootstrap=new Bootstrap(root,32199),services=createApp(undefined,undefined,undefined,bootstrap);
 cleanup.get(root)!.push(()=>services.app.close());
 await bootstrap.start(initialization??(()=>services.initialize(new Store(root,bootstrap.lease))),initialization?()=>{}:services.activate);
 return {bootstrap,...services};
}
const headers=(bootstrap:Bootstrap,post=false)=>({host:'127.0.0.1:32199','x-orchard-bootstrap-token':bootstrap.token,...(post?{origin:'http://127.0.0.1:32199','content-type':'application/json'}:{})});
async function confirm(bootstrap:Bootstrap){const p=await bootstrap.getPlan(),checked=await bootstrap.validate({planHash:p.planHash,answers:{}});return {requestId:randomUUID(),planHash:p.planHash,confirmationHash:checked.confirmationHash!,answers:{}};}

test('bootstrap permits only extension bridge POSTs and preserves bridge authentication',async t=>{
 const {app}=await boot(rootFor(t));
 const extensionId='a'.repeat(32),origin=`chrome-extension://${extensionId}`;
 const extensionHeaders={host:'127.0.0.1:32199',origin,'sec-fetch-site':'cross-site'};
 const registration=await app.inject({method:'POST',url:'/api/web-bridge/profiles/register',headers:extensionHeaders,payload:{id:'work',name:'Work',extensionId}});
 assert.equal(registration.statusCode,200,registration.body);
 const token=registration.json().bridgeToken;
 assert.equal(typeof token,'string');
 const poll=await app.inject({method:'POST',url:'/api/web-bridge/browser/poll',headers:{...extensionHeaders,'x-orchard-bridge-token':token},payload:{profileId:'work'}});
 assert.equal(poll.statusCode,200,poll.body);
 assert.deepEqual(poll.json(),{items:[]});
 for(const url of ['/api/web-bridge/browser/poll','/api/web-bridge/browser/result']){
  const response=await app.inject({method:'POST',url,headers:extensionHeaders,payload:{profileId:'work'}});
  assert.equal(response.statusCode,401,response.body);
 }
 const mismatch=await app.inject({method:'POST',url:'/api/web-bridge/profiles/register',headers:extensionHeaders,payload:{id:'other',name:'Other',extensionId:'b'.repeat(32)}});
 assert.equal(mismatch.statusCode,400);
 assert.equal(mismatch.json().code,'INVALID_ORIGIN');
 for(const options of [
  {method:'GET' as const,url:'/api/web-bridge/profiles/register'},
  {method:'OPTIONS' as const,url:'/api/web-bridge/profiles/register'},
  {method:'POST' as const,url:'/api/web-bridge/calls'},
  {method:'POST' as const,url:'/api/bootstrap/initialize'},
  {method:'POST' as const,url:'/api/migrations/jobs'},
  {method:'POST' as const,url:'/api/web-bridge/profiles/register',headers:{...extensionHeaders,origin:'https://evil.test'}},
  {method:'POST' as const,url:'/api/web-bridge/profiles/register',headers:{...extensionHeaders,origin:'chrome-extension://invalid'}},
  {method:'POST' as const,url:'/api/web-bridge/profiles/register',headers:{...extensionHeaders,host:'evil.test:32199'}},
 ]){
  const response=await app.inject({headers:extensionHeaders,...options});
  assert.equal(response.statusCode,403,`${options.method} ${options.url}: ${response.body}`);
 }
});

test('bootstrap keeps extension registration behind the readiness barrier',async t=>{
 const {app}=await boot(fixture(t),async()=>{});
 const response=await app.inject({method:'POST',url:'/api/web-bridge/profiles/register',headers:{host:'127.0.0.1:32199',origin:`chrome-extension://${'a'.repeat(32)}`,'sec-fetch-site':'cross-site'},payload:{id:'work',name:'Work',extensionId:'a'.repeat(32)}});
 assert.equal(response.statusCode,503,response.body);
 assert.equal(response.json().code,'MIGRATION_REQUIRED');
});

test('M01 new installation and reopen initialize once; Store requires an authentic lease',async t=>{
 const root=rootFor(t),instance=await boot(root);assert.equal(instance.bootstrap.ready,true);
 assert.equal(readJson<{schemaVersion:number}>(safe(root,'config/web-bridge.json')).schemaVersion,1);
 assert.throws(()=>new Store(root,{} as DirectoryLease),/assert|INSTANCE_LOCKED/);
 const initialization=readFileSync(safe(root,'migrations/initialization.json'));
 await instance.app.close();cleanup.set(root,[]);const reopened=await boot(root);assert.equal(reopened.bootstrap.ready,true);assert.deepEqual(readFileSync(safe(root,'migrations/initialization.json')),initialization);
});
test('M02 all historical database versions and config versions reach the same target without executing queued work',async t=>{
 for(const version of [1,2,3,4,5,6,7,8])for(const config of [0,1,null] as const){
  const root=fixture(t,version,config),before=source(root);const p=await preview(root);assert.equal(source(root).fingerprint,before.fingerprint);
  assert.equal(p.sourceVersions.database,version);
  if(p.steps.length){const job=execute(root,accept(root));assert.equal(job.phase,'committed',JSON.stringify(job.error));assert.equal(source(root).database,currentVersion);assert.equal(source(root).webBridge,1);
   const db=new DatabaseSync(safe(root,'workbench.db'));assert.equal(db.prepare("SELECT status FROM runs WHERE id='run'").get()!.status,'queued');assert.equal(db.prepare("SELECT count(*) n FROM command_receipts").get()!.n,1);db.close();
   assert.equal(recoverJobs(root)[0].phase,'committed');
  }else{const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.ready,true);}
 }
});
test('v6 release ledgers keep their original migration identities when extending the chain to v9',t=>{
 const root=fixture(t,6,1);
 const migrations=declarations.filter(value=>value.kind==='database'&&value.from>=2&&value.to<=6);
 const ledger:Ledger={formatVersion:1,baseline:{database:2,webBridge:1,applicationId:1331110449,source:'previous release'},completed:[{jobId:randomUUID(),migrations,source:{database:2,webBridge:1},target:{database:6,webBridge:1}}]};
 writeJson(safe(root,'migrations/ledger.json'),ledger);
 assert.deepEqual(plan(root).steps.map(step=>step.id),['db.v6-v7','db.v7-v8','db.v8-v9']);
 const job=execute(root,accept(root));assert.equal(job.phase,'committed',JSON.stringify(job.error));
 const updated=readJson<Ledger>(safe(root,'migrations/ledger.json'));
 assert.deepEqual(updated.completed[0],ledger.completed[0]);assert.equal(updated.completed.length,2);
 assert.equal(plan(root).steps.length,0);assert.equal(source(root).database,9);
});
test('ledger accepts default config initialization between baseline and migration without rewriting history',async t=>{
 const root=fixture(t,8,null);
 baseline(root);
 const ledgerPath=safe(root,'migrations/ledger.json'),before=readFileSync(ledgerPath);
 writeJson(safe(root,'config/web-bridge.json'),defaultBridgeConfig());
 const job=execute(root,accept(root));assert.equal(job.phase,'committed',JSON.stringify(job.error));
 const committed=readFileSync(ledgerPath),ledger=readJson<Ledger>(ledgerPath);
 assert.deepEqual(ledger.baseline,JSON.parse(before.toString()).baseline);
 assert.equal(ledger.baseline.webBridge,null);assert.equal(ledger.completed[0].source.webBridge,1);
 assert.equal(plan(root).steps.length,0);
 const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.ready,true);
 assert.deepEqual(readFileSync(ledgerPath),committed);
 for(const invalidSource of [{database:7,webBridge:1},{database:8,webBridge:0},{database:9,webBridge:1}]){
  writeJson(ledgerPath,{...ledger,completed:[{...ledger.completed[0],source:invalidSource}]});
  assert.throws(()=>validateLedger(root,source(root)),{code:'LEDGER_MISMATCH'});
 }
 writeJson(ledgerPath,ledger);
});
test('M03 old, mixed, unknown and nonempty incomplete directories are blocked without replacing source files',async t=>{
 for(const kind of ['old','mixed','unknown','incomplete']){
  const root=kind==='mixed'?fixture(t,6,1):rootFor(t);
  if(kind==='old'||kind==='mixed')durable(safe(root,'orchard.db'),'old product');
  if(kind==='unknown'){const db=new DatabaseSync(safe(root,'workbench.db'));db.exec('CREATE TABLE foreign_data(x)');db.close();}
  if(kind==='incomplete')durable(safe(root,'important.txt'),'keep');
  const before=scan(root,readdirSync(root));const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.status().state,'blocked');
  for(const file of before.files.filter(f=>f.type==='file'))assert.equal(scan(root,[file.path]).files[0].hash,file.hash);
 }
});
test('M04 missing optional config is initialized, while zero-length, future, malformed and escaped-duplicate configs are blocked',async t=>{
 const valid=fixture(t,currentVersion,null),instance=await boot(valid,async()=>{});assert.equal(instance.bootstrap.ready,true);
 for(const content of ['', '{"schemaVersion":2}', '{', '{"applications":{},"applic\\u0061tions":{}}']){
  const root=fixture(t,6,1);writeFileSync(safe(root,'config/web-bridge.json'),content);const app=await boot(root,async()=>{});assert.equal(app.bootstrap.status().state,'blocked');assert.equal(readFileSync(safe(root,'config/web-bridge.json'),'utf8'),content);
 }
});
test('M05 unknown schema, foreign keys, integrity, higher versions and symlink resources are rejected',async t=>{
 for(const kind of ['schema','foreign','higher','identity','link']){
  const root=fixture(t);const db=new DatabaseSync(safe(root,'workbench.db'));
  if(kind==='schema')db.exec('CREATE TABLE surprise(x)');if(kind==='foreign')db.exec("PRAGMA foreign_keys=OFF; UPDATE runs SET workflow_version_id='missing'");if(kind==='higher')db.exec('PRAGMA user_version=99');if(kind==='identity')db.exec('PRAGMA application_id=0');db.close();
  if(kind==='link')symlinkSync('/etc/hosts',safe(root,'artifacts/link'));
  assert.throws(()=>source(root));
 }
});
test('M06 logical fingerprint ignores checkpoints and includes row types, blob bytes and file permissions',t=>{
 const root=fixture(t),db=new DatabaseSync(safe(root,'workbench.db'));
 db.exec("PRAGMA journal_mode=WAL;UPDATE workflows SET name='wal' WHERE id='workflow'");const first=databaseFingerprint(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(databaseFingerprint(db),first);
 db.prepare("UPDATE command_receipts SET result_json=?").run(9007199254740993n);const integer=databaseFingerprint(db);db.prepare("UPDATE command_receipts SET result_json=?").run(Buffer.from([0,1,2]));assert.notEqual(databaseFingerprint(db),integer);db.close();
 const sourceBefore=source(root).fingerprint;chmodSync(safe(root,'agent-sessions/fixture/opaque.dat'),0o640);assert.notEqual(source(root).fingerprint,sourceBefore);
});
test('M07 stale source and confirmations are rejected before snapshots or formal writes',async t=>{
 const root=fixture(t),instance=await boot(root,async()=>{}),input=await confirm(instance.bootstrap);
 durable(safe(root,'agent-sessions/fixture/opaque.dat'),'changed');await assert.rejects(instance.bootstrap.submit(input),/PLAN_STALE/);assert.equal(present(safe(root,'backups')),false);
 const second=await confirm(instance.bootstrap);second.confirmationHash='unknown';await assert.rejects(instance.bootstrap.submit(second),/CONFIRMATION_EXPIRED/);
});
test('M08 typed questions, defaults, conditional branches, secrets and field errors are validated on the server',()=>{
 const questions:Question[]=[{key:'mode',type:'enum',label:'mode',description:'',required:true,default:'safe',options:[{value:'safe',label:'safe'},{value:'custom',label:'custom'}]},{key:'enabled',type:'boolean',label:'enabled',description:'',default:false},{key:'count',type:'integer',label:'count',description:'',min:1,max:3,required:true},{key:'secret',type:'secret',label:'secret',description:'',default:'must-not-fill',required:true,when:{key:'mode',equals:'custom'}},{key:'name',type:'string',label:'name',description:'',pattern:'^[a-z]+$'}];
 assert.deepEqual({...validateAnswers(questions,{count:2}).answers},{mode:'safe',enabled:false,count:2});
 assert.equal(Object.keys(validateAnswers(questions,{mode:'custom',enabled:'yes',count:4,name:'BAD',extra:1}).fieldErrors).length,5);
 assert.equal(validateAnswers(questions,{mode:'safe',count:2,secret:'unused'}).fieldErrors.secret,'当前分支不接受此字段');
 assert.equal(validateAnswers(questions,{mode:'custom',count:1,secret:'entered'}).answers.secret,'entered');
});
test('M09 job acceptance is durable, duplicate requests converge and conflicting payloads are rejected',async t=>{
 const root=fixture(t),instance=await boot(root,async()=>{}),input=await confirm(instance.bootstrap);
 const [a,b]=await Promise.all([instance.bootstrap.submit(input),instance.bootstrap.submit(input)]);assert.equal(a.jobId,b.jobId);assert.equal(readJson<Job>(safe(root,`migrations/jobs/${a.jobId}/state.json`)).jobId,a.jobId);
 assert.equal((await instance.bootstrap.submit({...input,confirmationHash:'refreshed-confirmation'})).jobId,a.jobId);
 assert.equal((await instance.bootstrap.submit({...input,requestId:randomUUID()})).jobId,a.jobId);
 await assert.rejects(instance.bootstrap.submit({...input,requestId:randomUUID(),answers:{unexpected:true}}),/MIGRATION_BUSY/);
 await assert.rejects(instance.bootstrap.submit({...input,answers:{different:true}}),/REQUEST_CONFLICT/);
 await until(()=>instance.bootstrap.ready,15000);assert.equal(instance.bootstrap.jobView(a.jobId).phase,'committed');
});
test('M10 auth, exact local host/origin and business/SSE/proxy gates work before readiness',async t=>{
 const root=fixture(t),{bootstrap,app}=await boot(root,async()=>{});
 const session=await app.inject({url:'/api/bootstrap/session',headers:{host:'127.0.0.1:32199',origin:'http://127.0.0.1:32199','x-orchard-bootstrap':'1'}});assert.equal(session.statusCode,200);
 for(const options of [{url:'/api/migrations/plan',headers:{host:'127.0.0.1:32199'}},{url:'/api/bootstrap/session',headers:{host:'127.0.0.1:32199'}},{url:'/api/bootstrap/status',headers:{host:'attacker.test:32199'}},{url:'/api/bootstrap/status',headers:{...headers(bootstrap),origin:'http://evil.test'}},{method:'POST' as const,url:'/api/migrations/jobs',headers:headers(bootstrap),payload:{}}])assert.ok((await app.inject(options)).statusCode>=400);
 for(const url of ['/api/workflows','/api/providers','/api/runs','/api/runs/run/stream','/api/web-bridge/status'])assert.equal((await app.inject({url,headers:headers(bootstrap)})).statusCode,503,url);
 assert.equal((await app.inject({method:'POST',url:'/api/web-bridge/calls',headers:headers(bootstrap,true),payload:{}})).statusCode,503);
 assert.equal((await app.inject({url:'/api/ready',headers:headers(bootstrap)})).statusCode,503);
 assert.equal((await app.inject({url:'/api/health',headers:headers(bootstrap)})).statusCode,200);
 assert.equal((await app.inject({url:'/api/not-a-route',headers:headers(bootstrap)})).statusCode,404);
 const publicStatus=(await app.inject({url:'/api/bootstrap/status',headers:{host:'127.0.0.1:32199'}})).json();assert.equal(publicStatus.dataDir,undefined);assert.equal(publicStatus.error,undefined);
});
test('M11 accepted HTTP jobs return 202 with a status URL; reports are authenticated and contain no answers',async t=>{
 const root=fixture(t),{bootstrap,app}=await boot(root,async()=>{}),input=await confirm(bootstrap);
 const response=await app.inject({method:'POST',url:'/api/migrations/jobs',headers:headers(bootstrap,true),payload:input});assert.equal(response.statusCode,202);assert.equal((await app.inject({url:response.json().statusUrl,headers:headers(bootstrap)})).statusCode,200);
 await until(()=>bootstrap.ready,15000);
 const report=await app.inject({url:`${response.json().statusUrl}/report`,headers:headers(bootstrap)});assert.equal(report.statusCode,200);assert.ok(!report.body.includes(input.confirmationHash));assert.ok(!report.body.includes('inputHmac'));assert.ok(!report.body.includes('answers'));
});
test('M12 partial initialization cleans up, retries idempotently and readiness remains false until completion',async t=>{
 const root=fixture(t,currentVersion,1);let calls=0;const instance=await boot(root,async()=>{calls++;if(calls===1)throw new Error('sensitive failure');});
 assert.equal(instance.bootstrap.status().state,'initialization_failed');assert.equal(instance.bootstrap.ready,false);
 const id=randomUUID(),a=await instance.bootstrap.operation('initialize',id),b=await instance.bootstrap.operation('initialize',id);assert.deepEqual(a,b);
 await until(()=>instance.bootstrap.ready);assert.equal(calls,2);
});
test('M13 backup manifests preserve opaque session bytes, modes, missing paths and validated original fingerprints',t=>{
 const root=fixture(t),job=execute(root,accept(root));assert.equal(job.phase,'committed');
 const backup=safe(root,`backups/migrations/${job.jobId}/snapshot`);assert.deepEqual(readFileSync(safe(backup,'agent-sessions/fixture/opaque.dat')),Buffer.from([0,1,255,10]));
 const snapshot=readJson<{fingerprint:string}>(safe(root,`backups/migrations/${job.jobId}/manifest.json`));assert.equal(snapshot.fingerprint,job.plan.sourceFingerprint);
 assert.equal(recoverJobs(root)[0].phase,'committed');
});
test('M14 transformation failures preserve formal input and backups, without business initialization',t=>{
 const root=fixture(t),job=accept(root),before=source(root).fingerprint;
 const result=execute(root,job,point=>{if(point==='transform:db.v2-v3:after')throw new Error('injected');});assert.equal(result.phase,'failed');assert.equal(source(root).fingerprint,before);assert.ok(present(safe(root,`backups/migrations/${job.jobId}/manifest.json`)));
});
test('M15 partial installs roll back every replaced resource and leave a separately retryable attempt',t=>{
 const root=fixture(t),job=accept(root),before=source(root).fingerprint;
 const result=execute(root,job,point=>{if(point==='install:workbench.db:after')throw new Error('injected');});assert.equal(result.phase,'restored',JSON.stringify(result.error));assert.equal(source(root).fingerprint,before);
 const retry=accept(root);retry.attemptOf=job.jobId;assert.notEqual(retry.jobId,job.jobId);assert.equal(execute(root,retry).phase,'committed');
});
test('M16 unknown formal bytes stop recovery before any further overwrite; correcting the conflict permits recovery',t=>{
 const root=fixture(t),job=accept(root);let original:Buffer|undefined;
 const result=execute(root,job,point=>{if(point==='install:workbench.db:after'){original=readFileSync(safe(root,'config/web-bridge.json'));durable(safe(root,'config/web-bridge.json'),'unknown content');throw new Error('injected');}});
 assert.equal(result.phase,'recovery_required');assert.equal(readFileSync(safe(root,'config/web-bridge.json'),'utf8'),'unknown content');
 durable(safe(root,'config/web-bridge.json'),original!);assert.equal(restore(root,result).phase,'restored');
});
test('M17 corrupted snapshots and unknown install protocols block recovery without overwriting formal files',t=>{
 for(const corruption of ['snapshot','protocol','scope']){
  const root=fixture(t),job=accept(root);
  const result=execute(root,job,point=>{if(point==='install:workbench.db:after'){
   if(corruption==='snapshot')durable(safe(root,`backups/migrations/${job.jobId}/snapshot/workbench.db`),'bad backup');else if(corruption==='scope'){job.install[0].path='migrations/private-key';writeJson(safe(root,`migrations/jobs/${job.jobId}/install.json`),{formatVersion:1,items:job.install});}else writeJson(safe(root,`migrations/jobs/${job.jobId}/install.json`),{formatVersion:99});
   throw new Error('injected');
  }});assert.equal(result.phase,'recovery_required');assert.equal(result.error?.code,corruption==='snapshot'?'BACKUP_CORRUPT':'UNKNOWN_PROTOCOL');
 }
});
test('M18 completed job replay never restores edited business data',t=>{
 const root=fixture(t),job=execute(root,accept(root));const db=new DatabaseSync(safe(root,'workbench.db'));db.exec("UPDATE workflows SET name='after commit'");db.close();
 assert.equal(recoverJobs(root)[0].phase,'committed');const reopened=new DatabaseSync(safe(root,'workbench.db'));try{assert.equal(reopened.prepare('SELECT name FROM workflows').get()!.name,'after commit');}finally{reopened.close();}assert.equal(job.phase,'committed');
});
test('M19 missing ledgers reconstruct only from complete committed chains; unknown declarations and backdated versions block',t=>{
 const root=fixture(t),job=execute(root,accept(root));rmSync(safe(root,'migrations/ledger.json'));recoverJobs(root);assert.equal(readJson<Ledger>(safe(root,'migrations/ledger.json')).completed[0].jobId,job.jobId);
 const ledger=readJson<Ledger>(safe(root,'migrations/ledger.json'));ledger.completed[0].migrations[0].checksum='unknown';writeJson(safe(root,'migrations/ledger.json'),ledger);assert.throws(()=>plan(root),/LEDGER_MISMATCH/);
});
test('M20 canonical request identities and sessions do not store confirmation tokens or secrets in public job files',async t=>{
 const root=fixture(t),instance=await boot(root,async()=>{}),input=await confirm(instance.bootstrap),accepted=await instance.bootstrap.submit(input);await until(()=>instance.bootstrap.ready,15000);
 const state=readFileSync(safe(root,`migrations/jobs/${accepted.jobId}/state.json`),'utf8');assert.ok(!state.includes(input.confirmationHash));assert.ok(!state.includes(instance.bootstrap.token));assert.ok(!state.includes('answers'));
 assert.ok(present(safe(root,'migrations/private-key')));
});
test('M21 responsive status and health remain available during worker scans and execution',async t=>{
 const root=fixture(t);for(let i=0;i<100;i++)durable(safe(root,`agent-sessions/large/${i}.bin`),Buffer.alloc(16384,i));
 const {bootstrap,app}=await boot(root,async()=>{}),input=await confirm(bootstrap);await bootstrap.submit(input);
 for(let i=0;i<6;i++){const started=Date.now();assert.equal((await app.inject({url:'/api/bootstrap/status',headers:headers(bootstrap)})).statusCode,200);assert.ok(Date.now()-started<1000);}
 await until(()=>bootstrap.ready,15000);
});
async function killAt(root:string,boundary:string,kind='job'){
 const child=fork(new URL('./fixtures/migrations/kill-runner.ts',import.meta.url),[root,boundary,kind],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',chunk=>errors+=String(chunk));
 const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);
 const observed=await Promise.race([once(child,'message').then(([message])=>message),once(child,'exit').then(()=>{throw new Error(`child exited before ${boundary}: ${errors}`);})]);
 assert.equal(observed,boundary);const exited=once(child,'exit');child.kill('SIGKILL');await exited;clearTimeout(timeout);
}
test('M22 process kill before installation leaves original logical source intact and a failed attempt',async t=>{
 for(const point of ['state:accepted:before','state:accepted:after','state:backing_up:before','state:backing_up:after','backup:workbench.db:before','backup:workbench.db:after','state:backup_complete:before','state:backup_complete:after',...Array.from({length:7},(_,i)=>`transform:db.v${i+1}-v${i+2}:after`),'transform:config.web-bridge.v0-v1:after','state:verifying:after','state:prepared:before','state:prepared:after','state:installing:before']){
  const root=fixture(t,1),job=accept(root),fingerprint=source(root).fingerprint;await killAt(root,point);const jobs=recoverJobs(root);assert.equal(jobs[0].phase,'failed',point);assert.equal(source(root).fingerprint,fingerprint);assert.equal(jobs[0].jobId,job.jobId);
 }
});
test('M23 process kill at each installation and ledger boundary restores the original before accepting retries',async t=>{
 for(const point of ['state:installing:after','install:workbench.db:before','install:workbench.db:after','install:config/web-bridge.json:before','install:config/web-bridge.json:after','state:installed:before','state:installed:after','ledger:before','ledger:after','state:committed:before']){
  const root=fixture(t),job=accept(root),fingerprint=source(root).fingerprint;await killAt(root,point);const recovered=recoverJobs(root)[0];assert.equal(recovered.phase,'restored',`${point}: ${JSON.stringify(recovered.error)}`);assert.equal(source(root).fingerprint,fingerprint);assert.equal(recovered.jobId,job.jobId);
 }
});
test('M24 interrupted recovery resumes idempotently; committed kill advances without restoring',async t=>{
 for(const boundary of ['state:restoring:before','state:restoring:after','restore:workbench.db:before','restore:workbench.db:after','restore:config/web-bridge.json:before','restore:config/web-bridge.json:after','state:restored:before','state:restored:after']){const root=fixture(t);accept(root);await killAt(root,boundary,'restore');assert.equal(recoverJobs(root)[0].phase,'restored',boundary);}
 const committedRoot=fixture(t);accept(committedRoot);await killAt(committedRoot,'state:committed:after');assert.equal(recoverJobs(committedRoot)[0].phase,'committed');assert.equal(source(committedRoot).database,currentVersion);
});
test('M25 interrupted new initialization installs only recorded target bytes and is resumable at every durable boundary',async t=>{
 for(const point of ['initialization:preparing','initialization:prepared','initialization:installing','initialization:workbench.db:after','initialization:config/web-bridge.json:after','initialization:committed']){
  const root=rootFor(t);await killAt(root,point,'initialize');const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.ready,true,`${point}: ${JSON.stringify(instance.bootstrap.status(true))}`);
 }
});
test('unpublished acceptance crashes discard only staging secrets; published acceptance recovers as one failed attempt',async t=>{
 for(const boundary of ['acceptance:state:before','acceptance:state:after','acceptance:input:before','acceptance:input:after','acceptance:publish:before','acceptance:publish:after']){
  const root=fixture(t),job=accept(root),fingerprint=source(root).fingerprint;writeJson(safe(root,'runtime/test-accept.json'),job);rmSync(safe(root,`migrations/jobs/${job.jobId}`),{recursive:true});
  await killAt(root,boundary,'accept');const jobs=recoverJobs(root);assert.equal(jobs.length,boundary==='acceptance:publish:after'?1:0);if(jobs.length)assert.equal(jobs[0].phase,'failed');
  assert.deepEqual(readdirSync(safe(root,'migrations/accepting')),[]);assert.equal(present(safe(root,`migrations/jobs/${job.jobId}/private-input.json`)),false);assert.equal(source(root).fingerprint,fingerprint);
 }
});
test('optional-config initialization resumes after every recorded installation boundary',async t=>{
 for(const boundary of ['initialization:preparing','initialization:prepared','initialization:installing','initialization:config/web-bridge.json:after','initialization:committed']){
  const root=fixture(t,currentVersion,null);await killAt(root,boundary,'optional');const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.ready,true,JSON.stringify(instance.bootstrap.status(true)));
 }
});
test('M26 initialization target conflicts and interrupted unknown records are blocked safely',async t=>{
 const root=rootFor(t);await killAt(root,'initialization:prepared','initialize');durable(safe(root,'workbench.db'),'someone else');const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.status(true).error?.code,'RECOVERY_CONFLICT');assert.equal(readFileSync(safe(root,'workbench.db'),'utf8'),'someone else');
 const unknown=fixture(t);writeJson(safe(unknown,'migrations/initialization.json'),{formatVersion:99});assert.equal((await boot(unknown,async()=>{})).bootstrap.status(true).error?.code,'UNKNOWN_PROTOCOL');
});
test('M27 simultaneous lock acquisition and stale-lock reclamation allow exactly one owner',async t=>{
 const root=rootFor(t),lease=DirectoryLease.acquire(root);assert.throws(()=>DirectoryLease.acquire(root),/INSTANCE_LOCKED/);lease.release();
 const first=fork(new URL('./fixtures/migrations/lock-runner.ts',import.meta.url),[root],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']});await once(first,'message');const exited=once(first,'exit');first.kill('SIGKILL');await exited;
 const children=[0,1].map(()=>fork(new URL('./fixtures/migrations/lock-runner.ts',import.meta.url),[root],{execArgv:['--import','tsx'],stdio:['ignore','ignore','ignore','ipc']}));const outcomes=await Promise.all(children.map(async child=>(await once(child,'message'))[0]));assert.equal(outcomes.filter(v=>v==='acquired').length,1);
 await Promise.all(children.map(async child=>{const ended=once(child,'exit');child.kill('SIGKILL');await ended;}));
 const recovered=DirectoryLease.acquire(root);recovered.release();
});
test('M28 stale job requests deduplicate across restart, new confirmations are required and private-key loss blocks writes',async t=>{
 const root=fixture(t),first=await boot(root,async()=>{}),input=await confirm(first.bootstrap),accepted=await first.bootstrap.submit(input);await until(()=>first.bootstrap.ready,15000);await first.app.close();cleanup.set(root,[]);
 const next=await boot(root,async()=>{});assert.equal((await next.bootstrap.submit(input)).jobId,accepted.jobId);await next.app.close();cleanup.set(root,[]);rmSync(safe(root,'migrations/private-key'));const missing=await boot(root,async()=>{});assert.equal(missing.bootstrap.status(true).error?.code,'PRIVATE_KEY_MISSING');
});
test('M29 preexisting locks of uncertain ownership and path escapes are rejected',t=>{
 const root=rootFor(t);durable(safe(root,'workbench.lock'),'malformed');assert.throws(()=>DirectoryLease.acquire(root),/INSTANCE_LOCKED/);assert.equal(readFileSync(safe(root,'workbench.lock'),'utf8'),'malformed');
 for(const relative of ['../outside','a/../b','/absolute','a\\b','a//b'])assert.throws(()=>safe(root,relative),/INVALID_PATH/);
});
test('M30 initialization retries and ordinary Store reopen do not run structural migrations',async t=>{
 const root=fixture(t),lease=DirectoryLease.acquire(root),before=source(root).fingerprint;assert.throws(()=>new Store(root,lease),/尚未就绪/);assert.equal(source(root).fingerprint,before);lease.release();
 const instance=await boot(root,async()=>{});assert.equal(instance.bootstrap.status().state,'migration_required');await assert.rejects(instance.bootstrap.operation('initialize',randomUUID()),/INVALID_STATE/);
});

test('question fixture resolves nested branches consistently and runner consumes private answers without publishing them',t=>{
 const declaration=declarations.find(value=>value.id==='db.v2-v3')!,original=declaration.questions;declaration.questions=testQuestions;
 try{
  const root=fixture(t),job=accept(root),answers={'test.questions/mode':'custom','test.questions/secret':'private-answer','test.questions/count':3};
  const automatic=resolvePlan(job.plan,{}),custom=resolvePlan(job.plan,answers);
  assert.notEqual(automatic.plan.planHash,custom.plan.planHash);assert.equal(resolvePlan(custom.plan,answers).plan.planHash,custom.plan.planHash);
  assert.equal(questionActive(testQuestions.at(-1)!,testQuestions,{'test.questions/name':'nested'}),false);
  assert.ok(validateAnswers(testQuestions,{'test.questions/nested':'hidden'}).fieldErrors['test.questions/nested']);
  job.plan=custom.plan;writeJson(safe(root,`migrations/jobs/${job.jobId}/private-input.json`),custom.answers);writeJson(safe(root,`migrations/jobs/${job.jobId}/state.json`),job);
  assert.equal(execute(root,job).phase,'committed',JSON.stringify(job.error));assert.equal(present(safe(root,`migrations/jobs/${job.jobId}/private-input.json`)),false);
  const publicFiles=[`migrations/jobs/${job.jobId}/state.json`,`migrations/jobs/${job.jobId}/events.jsonl`,'migrations/ledger.json'];
  for(const path of publicFiles)assert.equal(readFileSync(safe(root,path),'utf8').includes('private-answer'),false);
 }finally{declaration.questions=original;}
});
test('unwritable roots and installation ENOSPC fail safely without mixing database and configuration versions',async t=>{
 const root=fixture(t),before=source(root).fingerprint,job=accept(root);chmodSync(root,0o500);
 try{await assert.rejects(preview(root),{code:'EACCES'});const result=execute(root,job);assert.equal(result.phase,'failed');assert.equal(result.error?.code,'IO_ERROR');assert.equal(source(root).fingerprint,before);}finally{chmodSync(root,0o700);}
 const installing=fixture(t),original=source(installing).fingerprint,result=execute(installing,accept(installing),boundary=>{if(boundary==='install:workbench.db:after')throw Object.assign(new Error('injected'),{code:'ENOSPC'});});
 assert.equal(result.phase,'restored');assert.equal(result.error?.code,'INSUFFICIENT_SPACE');assert.equal(source(installing).fingerprint,original);
});
test('disk exhaustion and external writes before installation preserve formal resources and allow a fresh plan',t=>{
 for(const reason of ['space','external'] as const){const root=fixture(t),job=accept(root),before=source(root).fingerprint;
  const result=execute(root,job,name=>{if(name==='backup:workbench.db:before'){if(reason==='space')throw Object.assign(new Error('private platform detail'),{code:'ENOSPC'});writeJson(safe(root,'config/web-bridge.json'),{...readJson<Record<string,unknown>>(safe(root,'config/web-bridge.json')),unknown:'external-user-change'});}});
  assert.equal(result.phase,'failed');assert.equal(result.error?.code,reason==='space'?'INSUFFICIENT_SPACE':'SOURCE_CHANGED');assert.equal(result.install.length,0);
  if(reason==='space')assert.equal(source(root).fingerprint,before);else{assert.notEqual(source(root).fingerprint,before);assert.equal(readJson<{unknown:string}>(safe(root,'config/web-bridge.json')).unknown,'external-user-change');assert.notEqual(plan(root).planHash,job.plan.planHash);}
 }
});
test('partial installation with previously missing optional config restores its absence and removes only its newly created empty parent',t=>{
 const root=fixture(t,5,null),job=accept(root),before=source(root).fingerprint;
 const result=execute(root,job,name=>{if(name==='install:config/web-bridge.json:after')throw new Error('injected');});
 assert.equal(result.phase,'restored',JSON.stringify(result.error));assert.equal(source(root).fingerprint,before);assert.equal(present(safe(root,'config/web-bridge.json')),false);
});
test('business initialization after commit can retry with converging operation identities without repeating migration',async t=>{
 const root=fixture(t);let calls=0,release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
 const instance=await boot(root,async()=>{calls++;if(calls===1)throw new Error('partial initialization');await wait;});
 const accepted=await instance.bootstrap.submit(await confirm(instance.bootstrap));await until(()=>instance.bootstrap.status().state==='initialization_failed',15000);
 assert.equal(instance.bootstrap.jobView(accepted.jobId).phase,'committed');assert.equal(readJson<Ledger>(safe(root,'migrations/ledger.json')).completed.length,1);
 const requestId=randomUUID(),a=await instance.bootstrap.operation('initialize',requestId),b=await instance.bootstrap.operation('initialize',randomUUID());assert.deepEqual(a,b);
 await until(()=>calls===2);assert.equal(instance.bootstrap.ready,false);release();await until(()=>instance.bootstrap.ready);assert.equal(calls,2);
 assert.deepEqual(await instance.bootstrap.operation('initialize',requestId),a);assert.equal(readJson<Ledger>(safe(root,'migrations/ledger.json')).completed.length,1);
});
test('WAL-backed rehearsal sees committed data without checkpointing; a pinned reader blocks installation safely',async t=>{
 const root=fixture(t,6,0),writer=new DatabaseSync(safe(root,'workbench.db')),reader=new DatabaseSync(safe(root,'workbench.db'),{readOnly:true});
 try{writer.exec("PRAGMA journal_mode=WAL;UPDATE workflows SET name='first WAL change'");reader.exec('BEGIN');reader.prepare('SELECT name FROM workflows').get();writer.exec("UPDATE workflows SET name='committed WAL change'");
  const fingerprint=source(root).fingerprint,wal=readFileSync(safe(root,'workbench.db-wal'));await preview(root);assert.equal(source(root).fingerprint,fingerprint);assert.deepEqual(readFileSync(safe(root,'workbench.db-wal')),wal);
  const result=execute(root,accept(root));assert.equal(result.phase,'failed');assert.equal(result.error?.code,'MIGRATION_BUSY');assert.equal(source(root).fingerprint,fingerprint);
 }finally{reader.exec('ROLLBACK');reader.close();writer.close();}
});
test('native Pi files and Codex references remain byte-identical through rehearsal, migration and backups',async t=>{
 for(const kind of ['pi','codex'] as const){const root=fixture(t,3),session=safe(root,'agent-sessions/pi/native/session.jsonl');directory(dirname(session));const bytes=Buffer.from([0,255,123,10]);durable(session,bytes);
  const reference=JSON.stringify({version:1,kind,cwd:safe(root,'agent-workspaces/fixture'),...(kind==='pi'?{sessionId:'native',sessionFile:session}:{threadId:'native-thread'}),unknown:{preserve:true}});
  const db=new DatabaseSync(safe(root,'workbench.db'));db.prepare("UPDATE agent_conversations SET backend_ref_json=?,transport='native'").run(reference);db.close();
  const fingerprint=source(root).fingerprint;await preview(root);assert.equal(source(root).fingerprint,fingerprint);const result=execute(root,accept(root));assert.equal(result.phase,'committed',JSON.stringify(result.error));
  const target=new DatabaseSync(safe(root,'workbench.db'),{readOnly:true});assert.ok(target.prepare('SELECT backend_ref_json FROM agent_conversations').all().every(row=>row.backend_ref_json===reference));target.close();
  assert.deepEqual(readFileSync(session),bytes);assert.deepEqual(readFileSync(safe(root,`backups/migrations/${result.jobId}/snapshot/agent-sessions/pi/native/session.jsonl`)),bytes);
 }
});
test('M23 malformed native references and incorrect managed file types block without altering database bytes',t=>{
 for(const invalid of ['null','array','session-directory','workspace-file']){
  const root=fixture(t,3),session=safe(root,'agent-sessions/pi/native/session.jsonl');directory(dirname(session));durable(session,'native session');
  durable(safe(root,'agent-workspaces/not-a-directory'),'workspace file');
  const reference=invalid==='null'?null:invalid==='array'?[]:{version:1,kind:'pi',cwd:safe(root,invalid==='workspace-file'?'agent-workspaces/not-a-directory':'agent-workspaces/fixture'),sessionFile:invalid==='session-directory'?dirname(session):session};
  const db=new DatabaseSync(safe(root,'workbench.db'));db.prepare('UPDATE agent_conversations SET backend_ref_json=?').run(JSON.stringify(reference));db.close();const before=readFileSync(safe(root,'workbench.db'));
  assert.throws(()=>plan(root),/DATABASE_CORRUPT/,invalid);assert.deepEqual(readFileSync(safe(root,'workbench.db')),before);assert.equal(present(safe(root,'backups/migrations')),false);
 }
});
test('M23 Pi references to preallocated session files remain migratable before their first turn',t=>{
 const root=fixture(t,3),session=safe(root,'agent-sessions/pi/preallocated.jsonl'),reference=JSON.stringify({version:1,kind:'pi',sessionId:'preallocated',sessionFile:session,cwd:safe(root,'agent-workspaces/fixture')});
 assert.equal(present(session),false);const db=new DatabaseSync(safe(root,'workbench.db'));db.prepare("UPDATE agent_conversations SET backend_ref_json=?,transport='native'").run(reference);db.close();
 assert.equal(execute(root,accept(root)).phase,'committed');const target=new DatabaseSync(safe(root,'workbench.db'),{readOnly:true});try{assert.ok(target.prepare('SELECT backend_ref_json FROM agent_conversations').all().every(row=>row.backend_ref_json===reference));}finally{target.close();}assert.equal(present(session),false);
});
test('missing migration links and unexplained version advances block without writing formal resources',t=>{
 const root=fixture(t,1),before=source(root).fingerprint,index=declarations.findIndex(value=>value.id==='db.v1-v2'),[removed]=declarations.splice(index,1);
 try{assert.throws(()=>plan(root),/CHAIN_UNSUPPORTED/);assert.equal(source(root).fingerprint,before);}finally{declarations.splice(index,0,removed!);}
 baseline(root);const db=new DatabaseSync(safe(root,'workbench.db'));db.exec('PRAGMA foreign_keys=OFF');db.exec(readFileSync(resolve('docs/features/2026-11-06-data-migration/sql/db.v1-v2.sql'),'utf8'));db.close();
 assert.throws(()=>plan(root),/LEDGER_MISMATCH/);
});
test('M21 commit persistence errors reconcile from the durable marker without downgrading committed jobs',t=>{
 for(const boundary of ['state:committed:before','state:committed:after']){
  const root=fixture(t),original=source(root).fingerprint,job=accept(root);
  assert.throws(()=>execute(root,job,point=>{if(point===boundary)throw new Error('commit persistence fixture');}),/commit persistence fixture/);
  const disk=readJson<Job>(safe(root,`migrations/jobs/${job.jobId}/state.json`));assert.equal(disk.phase,boundary.endsWith(':before')?'installed':'committed');
  const recovered=recoverJobs(root)[0];assert.equal(recovered.phase,boundary.endsWith(':before')?'restored':'committed');
  if(recovered.phase==='restored')assert.equal(source(root).fingerprint,original);else{assert.equal(source(root).database,currentVersion);assert.equal((readJson<Ledger>(safe(root,'migrations/ledger.json'))).completed.length,1);}
 }
});
test('ordinary navigation is permitted while malformed Unicode tokens are rejected without server errors',async t=>{
 const instance=await boot(fixture(t),async()=>{});
 const navigation=await instance.app.inject({url:'/',headers:{host:'127.0.0.1:32199','sec-fetch-site':'none'}});assert.notEqual(navigation.statusCode,403);
 const invalid=await instance.app.inject({url:'/api/migrations/plan',headers:{host:'127.0.0.1:32199','x-orchard-bootstrap-token':'é'.repeat(64)}});assert.equal(invalid.statusCode,401);
});
