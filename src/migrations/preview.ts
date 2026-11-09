import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, accessSync, constants, statfsSync } from 'node:fs';
import { plan, resolvePlan } from './planner.js';
import { safe, directory, scan, copyDurable, canonical, writeJson, present } from './journal.js';
import { resourceRoots, MigrationError } from './types.js';
import { applyDefinitions } from './definitions.js';
import { verifyDatabase } from './validators.js';
import { captureRows, verifyMapping } from './mapping.js';
import { defaultBridgeConfig } from './config.js';
import { validateBridgeConfigV1 } from '../web-bridge/config-validation.js';
/** Read-only rehearsal. SQLite backup sees committed WAL frames without checkpointing the source. */
export async function preview(root:string,answers:Record<string,unknown>={}){
 const initial=plan(root);if(!initial.steps.length)return initial;
 const checked=resolvePlan(initial,answers);if(Object.keys(checked.fieldErrors).length)return {...initial,status:'needs_input' as const};
 accessSync(root,constants.W_OK);
 if(present(safe(root,'config')))accessSync(safe(root,'config'),constants.W_OK);
 const space=statfsSync(root);if(Number(space.bavail)*Number(space.bsize)<initial.estimates.requiredBytes)throw new MigrationError('INSUFFICIENT_SPACE');
 const work=safe(root,`runtime/migration-previews/${randomUUID()}`);directory(work);
 try{
  const first=scan(root,resourceRoots.filter(r=>r!=='workbench.db'));
  const sourceDb=new DatabaseSync(safe(root,'workbench.db'),{readOnly:true});
  try{await backup(sourceDb,safe(work,'workbench.db'));}finally{sourceDb.close();}
  for(const item of first.files){const target=safe(work,item.path);if(item.type==='directory')directory(target);else copyDurable(safe(root,item.path),target,item.mode);}
  if(canonical(first)!==canonical(scan(root,resourceRoots.filter(r=>r!=='workbench.db')))||plan(root).planHash!==initial.planHash)throw new MigrationError('SOURCE_CHANGED');
  const db=new DatabaseSync(safe(work,'workbench.db'));
  try{
   const version=verifyDatabase(db,work,root),rows=captureRows(db);db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');
   try{applyDefinitions({database:db,root:work,sourceRoot:root,answers:Object.freeze(checked.answers)},initial.steps);verifyMapping(db,rows,version);verifyDatabase(db,work,root);db.exec('COMMIT');}
   catch(error){db.exec('ROLLBACK');throw error;}
  }finally{db.close();}
  const config=safe(work,'config/web-bridge.json');
  if(!present(config))writeJson(config,defaultBridgeConfig());
  validateBridgeConfigV1(readFileSync(config,'utf8'));
  if(plan(root).planHash!==initial.planHash)throw new MigrationError('SOURCE_CHANGED');
  return checked.plan;
 }finally{rmSync(work,{recursive:true,force:true});}
}
