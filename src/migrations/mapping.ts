import type { DatabaseSync } from 'node:sqlite';
import { canonical } from './journal.js';
import { MigrationError } from './types.js';
import { encode } from './validators.js';
import { currentVersion } from './frozen.js';
export function captureRows(db:DatabaseSync){
 const result:Record<string,Record<string,unknown>[]>={};
 for(const table of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
  const statement=db.prepare(`SELECT * FROM "${table.name}"`);statement.setReadBigInts(true);result[String(table.name)]=statement.all();
 }
 return result;
}
export function verifyMapping(db:DatabaseSync,before:ReturnType<typeof captureRows>,version:number,targetVersion=currentVersion){
 const after=captureRows(db);
 const serialize=(rows:Record<string,unknown>[])=>rows.map(row=>canonical(Object.fromEntries(Object.entries(row).map(([key,value])=>[key,encode(value)])))).sort();
 for(const [table,rows] of Object.entries(after)){
  const original=before[table]??[];
  const expected=original.map(row=>{
   const target={...row};
   if(table==='dictionaries'&&version<10&&targetVersion>=10)target.deleted_at=null;
   if(table==='runs'&&version===1&&targetVersion>=2)Object.assign(target,{draft_id:null,draft_revision:null,snapshot_path:null});
   if(['authoring_turns','authoring_messages'].includes(table)&&version<3&&targetVersion>=3)target.conversation_id=null;
   if(table==='authoring_turns'&&version<3&&targetVersion>=3)Object.assign(target,{backend_turn_id:null,connection_generation:null,submission_state:'not_sent',input_ref:null,result_ref:null});
   if(table==='agent_conversations'&&version<4&&targetVersion>=4){target.title=null;target.archived_at=row.status==='archived'?row.updated_at:null;if(row.status==='archived')target.status='idle';}
   if(table==='script_versions'&&version<6&&targetVersion>=6)target.timeout_ms=300000n;
   if(table==='agent_conversations'&&version<7&&targetVersion>=7){
    target.context_mode=row.mode==='single'?'isolated':'native';
    target.transport='native';
    if(row.transport==='legacy'){
     if(row.mode==='multi'&&target.status!=='archived')target.status='needs_rebuild';
     Object.assign(target,{connection_fingerprint:'',backend_ref_json:null,backend_generation:BigInt(String(row.backend_generation))+1n,synced_revision:null});
    }
   }
   if(table==='provider_settings'&&version<7&&targetVersion>=7&&['codex-cli','pi-cli'].includes(String(row.id))){
    const config=JSON.parse(String(row.config_json));
    if(config.transport!=='native'){target.config_json=db.prepare("SELECT json_set(?,'$.transport','native') value").get(String(row.config_json))!.value;target.revision=BigInt(String(row.revision))+1n;}
   }
   return target;
  });
  if(canonical(serialize(rows))!==canonical(serialize(expected)))throw new MigrationError('DATABASE_CORRUPT');
 }
 if(Object.keys(before).some(table=>!Object.hasOwn(after,table)))throw new MigrationError('DATABASE_CORRUPT');
}
