import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './journal.js';
import { MigrationError } from './types.js';
import { encode } from './validators.js';
export function captureRows(db:DatabaseSync){
 const result:Record<string,Record<string,unknown>[]>={};
 for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const statement=db.prepare(`SELECT * FROM "${table.name}"`);statement.setReadBigInts(true);result[String(table.name)]=statement.all();
 }
 return result;
}
export function verifyMapping(db:DatabaseSync,before:ReturnType<typeof captureRows>,version:number,targetVersion=6){
 const after=captureRows(db);
 const serialize=(rows:Record<string,unknown>[])=>rows.map(row=>canonical(Object.fromEntries(Object.entries(row).map(([key,value])=>[key,encode(value)])))).sort();
 for(const [table,rows] of Object.entries(after)){
  const original=before[table]??[];
  const expected=original.map(row=>{
   const target={...row};
   if(table==='runs'&&version===1&&targetVersion>=2)Object.assign(target,{draft_id:null,draft_revision:null,snapshot_path:null});
   if(['authoring_turns','authoring_messages'].includes(table)&&version<3&&targetVersion>=3)target.conversation_id=null;
   if(table==='authoring_turns'&&version<3&&targetVersion>=3)Object.assign(target,{backend_turn_id:null,connection_generation:null,submission_state:'not_sent',input_ref:null,result_ref:null});
   if(table==='agent_conversations'&&version<4&&targetVersion>=4){target.title=null;target.archived_at=row.status==='archived'?row.updated_at:null;if(row.status==='archived')target.status='idle';}
   if(table==='script_versions'&&version<6&&targetVersion>=6)target.timeout_ms=300000n;
   return target;
  });
  if(canonical(serialize(rows))!==canonical(serialize(expected)))throw new MigrationError('DATABASE_CORRUPT');
 }
 if(Object.keys(before).some(table=>!Object.hasOwn(after,table)))throw new MigrationError('DATABASE_CORRUPT');
}
