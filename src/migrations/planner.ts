import { questionActive, validateAnswers } from './questions.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { declarations, approval, currentVersion } from './frozen.js';
import { inspectBridgeConfig } from '../web-bridge/config-validation.js';
import { canonical, hash, safe, present, scan, readJson } from './journal.js';
import { resourceRoots, MigrationError, type Plan, type Ledger, type Question } from './types.js';
import { databaseFingerprint, verifyDatabase } from './validators.js';
export function source(root:string) {
  if(present(safe(root,'orchard.db')))throw new MigrationError(present(safe(root,'workbench.db'))?'MIXED_DATA_DIRECTORY':'OLD_DATA_DIRECTORY');
  if(!present(safe(root,'workbench.db')))throw new MigrationError('INCOMPLETE_DATA_DIRECTORY');
  const db=new DatabaseSync(safe(root,'workbench.db'),{readOnly:true});
  try {
    const database=verifyDatabase(db,root), dataVersion=db.prepare('PRAGMA data_version').get()!.data_version;
    const logical=databaseFingerprint(db);
    const first=scan(root,resourceRoots.filter(r=>r!=='workbench.db'));
    const config=safe(root,'config/web-bridge.json');
    const webBridge=present(config)?inspectBridgeConfig(readFileSync(config,'utf8')).version:null;
    const second=scan(root,resourceRoots.filter(r=>r!=='workbench.db'));
    if(canonical(first)!==canonical(second)||logical!==databaseFingerprint(db)||dataVersion!==db.prepare('PRAGMA data_version').get()!.data_version)throw new MigrationError('SOURCE_CHANGED');
    return { database, webBridge, fingerprint:hash(canonical({logical,files:first})), bytes:first.files.reduce((n,f)=>n+f.size,0)+Number(db.prepare('PRAGMA page_count').get()!.page_count)*Number(db.prepare('PRAGMA page_size').get()!.page_size) };
  } finally {db.close();}
}
export function validateLedger(root:string, versions:{database:number;webBridge:number|null}): Ledger|null {
  const path=safe(root,'migrations/ledger.json');
  if(!present(path))return null;
  const ledger=readJson<Ledger>(path);
  if(ledger.formatVersion!==1||!ledger.baseline||!Array.isArray(ledger.completed))throw new MigrationError('UNKNOWN_PROTOCOL');
  const versionsValid=(value:{database:number;webBridge:number|null})=>Number.isInteger(value.database)&&value.database>=1&&value.database<=currentVersion&&[null,0,1].includes(value.webBridge);
  if(ledger.baseline.applicationId!==1331110449||!versionsValid(ledger.baseline))throw new MigrationError('LEDGER_MISMATCH');
  let previous={database:ledger.baseline.database,webBridge:ledger.baseline.webBridge};
  for(const job of ledger.completed){
    const compatibleSource={...previous,webBridge:previous.webBridge===null&&job.source.webBridge===1?1:previous.webBridge};
    if(canonical(compatibleSource)!==canonical(job.source))throw new MigrationError('LEDGER_MISMATCH');
    if(!versionsValid(job.target)||job.target.database<previous.database||job.target.webBridge!==1)throw new MigrationError('LEDGER_MISMATCH');
    const expected=declarations.filter(d=>d.kind==='database'?d.from>=previous.database&&d.to<=job.target.database:previous.webBridge===0).map(d=>({id:d.id,checksum:d.checksum}));
    if(!expected.length||canonical(expected)!==canonical(job.migrations.map(({id,checksum})=>({id,checksum}))))throw new MigrationError('LEDGER_MISMATCH');
    previous=job.target;
  }
  const currentConfig=versions.webBridge===null?1:versions.webBridge;
  if(previous.database>versions.database||(previous.webBridge??0)>currentConfig)throw new MigrationError('LEDGER_MISMATCH');
  if(previous.database!==versions.database||(previous.webBridge!==null&&previous.webBridge!==currentConfig))throw new MigrationError('LEDGER_MISMATCH');
  return ledger;
}
export function plan(root:string):Plan {
  if(approval.status!=='approved')throw new MigrationError('SCHEMA_REVIEW_REQUIRED');
  const current=source(root);validateLedger(root,current);
  const steps:typeof declarations=[];
  for(let version=current.database;version<currentVersion;version++){
    const step=declarations.find(d=>d.kind==='database'&&d.from===version&&d.to===version+1);
    if(!step||step.requires.some(id=>!steps.some(previous=>previous.id===id)&&!declarations.some(previous=>previous.id===id&&previous.kind==='database'&&previous.to<=current.database)))throw new MigrationError('CHAIN_UNSUPPORTED');
    steps.push(step);
  }
  if(current.webBridge===0){const step=declarations.find(d=>d.id==='config.web-bridge.v0-v1');if(!step)throw new MigrationError('CHAIN_UNSUPPORTED');steps.push(step);}
  const resources=[...new Set(steps.flatMap(step=>step.affectedResources))];
  if(current.webBridge===null&&steps.length)resources.push('config/web-bridge.json');
  const value={sourceVersions:{database:current.database,webBridge:current.webBridge},targetVersions:{database:currentVersion,webBridge:1},sourceFingerprint:current.fingerprint,steps,resources,questions:steps.flatMap(step=>step.questions) as Question[],estimates:{bytes:current.bytes,requiredBytes:current.bytes*4+16*1024*1024},blockers:[]};
  return {status:'ready',...value,planHash:hash(canonical({formatVersion:1,root,...value}))};
}
export function resolvePlan(base:Plan,answers:Record<string,unknown>){
  const checked=validateAnswers(base.questions,answers);
  const branches=base.questions.filter(question=>questionActive(question,base.questions,checked.answers)).map(question=>question.key);
  const basePlanHash=base.basePlanHash??base.planHash;
  const planHash=base.questions.length?hash(canonical({formatVersion:1,basePlanHash,branches})):base.planHash;
  const questions=base.questions.map(question=>{if(question.type!=='secret')return question;const {default:ignored,...publicQuestion}=question;return publicQuestion;});
  return {plan:{...base,questions,planHash,...(base.questions.length?{basePlanHash}:{}),status:Object.keys(checked.fieldErrors).length?'needs_input' as const:'ready' as const},...checked};
}
export { validateAnswers } from './questions.js';
