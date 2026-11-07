import { DatabaseSync } from 'node:sqlite';
import { readFileSync, lstatSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { baselines, currentVersion } from './frozen.js';
import { MigrationError } from './types.js';
import { canonical, hash, safe, fileHash, present } from './journal.js';
export function databaseVersion(db: DatabaseSync): number {
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (Number(db.prepare('PRAGMA application_id').get()!.application_id) !== 1331110449 || !Number.isInteger(version) || version < 1) throw new MigrationError('UNKNOWN_DATABASE');
  if (version > currentVersion) throw new MigrationError('DATA_VERSION_TOO_NEW');
  return version;
}
const normalize = (sql: string) => {
  let quoted=false,result='';
  for(const character of sql){if(character==="'"){quoted=!quoted;result+=character;}else if(quoted)result+=character;else if(character!=='"'&&!/\s/.test(character))result+=character.toLowerCase();}
  return result;
};
function tableParts(sql: string) {
  const body = sql.slice(sql.indexOf('(')+1, sql.lastIndexOf(')'));
  let depth=0, quoted=false, start=0; const parts:string[]=[];
  for(let i=0;i<body.length;i++) { const c=body[i]; if(c==="'") quoted=!quoted; if(!quoted){ if(c==='(')depth++; if(c===')')depth--; if(c===','&&depth===0){parts.push(normalize(body.slice(start,i)));start=i+1;} } }
  parts.push(normalize(body.slice(start))); return parts.sort();
}
export function verifyDatabase(db: DatabaseSync, root?: string, originalRoot = root) {
  const version=databaseVersion(db), baseline=baselines[version];
  if (db.prepare('PRAGMA integrity_check').get()!.integrity_check !== 'ok') throw new MigrationError('DATABASE_CORRUPT');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new MigrationError('DATABASE_CORRUPT');
  const actual=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  if(actual.length!==baseline.objects.length) throw new MigrationError('SCHEMA_MISMATCH');
  for(let i=0;i<actual.length;i++) {
    const a=actual[i], b=baseline.objects[i];
    if(a.type!==b.type||a.name!==b.name||a.tbl_name!==b.tbl_name) throw new MigrationError('SCHEMA_MISMATCH');
    const left=a.type==='table'?tableParts(String(a.sql)):normalize(String(a.sql));
    const right=b.type==='table'?tableParts(String(b.sql)):normalize(String(b.sql));
    if(canonical(left)!==canonical(right)) throw new MigrationError('SCHEMA_MISMATCH');
  }
  for(const row of db.prepare('SELECT config_json,models_json FROM provider_settings').all()) {
    try { const config=JSON.parse(String(row.config_json)), models=JSON.parse(String(row.models_json)); if(!config||typeof config!=='object'||Array.isArray(config)||!Array.isArray(models)) throw new Error(); } catch { throw new MigrationError('DATABASE_CORRUPT'); }
  }
  const refs:Record<string,string[]>={runs:['input_ref','output_ref'],node_runs:['input_ref','output_ref'],node_attempts:['input_ref','output_ref'],stream_events:['payload_ref'],...(version>=3?{authoring_turns:['input_ref','result_ref']}:{})};
  for(const [table,columns] of Object.entries(refs))for(const row of db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all())for(const value of Object.values(row))if(value!==null){
    let reference:unknown;try{reference=JSON.parse(String(value));}catch{throw new MigrationError('DATABASE_CORRUPT');}
    if(reference&&typeof reference==='object'&&'artifactId' in reference&&(typeof reference.artifactId!=='string'||!db.prepare('SELECT id FROM artifacts WHERE id=?').get(reference.artifactId)))throw new MigrationError('DATABASE_CORRUPT');
  }
  if(root) {
    if(version>=3)for(const row of db.prepare('SELECT backend_ref_json FROM agent_conversations WHERE backend_ref_json IS NOT NULL').all()){
      let reference:Record<string,unknown>;try{reference=JSON.parse(String(row.backend_ref_json));}catch{throw new MigrationError('DATABASE_CORRUPT');}
      if(!reference||typeof reference!=='object'||Array.isArray(reference)||reference.version!==1||!['pi','codex'].includes(String(reference.kind))||typeof reference.cwd!=='string'||!isAbsolute(reference.cwd)||reference.cwd.includes('\0'))throw new MigrationError('DATABASE_CORRUPT');
      const cwd=relative(originalRoot!,reference.cwd);if(cwd==='agent-workspaces'||cwd.startsWith('agent-workspaces/')){const path=safe(root,cwd);if(present(path)&&!lstatSync(path).isDirectory())throw new MigrationError('DATABASE_CORRUPT');}
      if(reference.kind==='pi'){
        if(typeof reference.sessionFile!=='string'||!isAbsolute(reference.sessionFile))throw new MigrationError('INVALID_PATH');
        const session=relative(originalRoot!,reference.sessionFile);if(!session.startsWith('agent-sessions/pi/'))throw new MigrationError('INVALID_PATH');const path=safe(root,session);if(present(path)&&!lstatSync(path).isFile())throw new MigrationError('DATABASE_CORRUPT');
      }
    }
    for(const row of db.prepare('SELECT relative_path,sha256,byte_size FROM artifacts').all()) {
      const path=safe(root,String(row.relative_path)); const bytes=readFileSync(path);
      if(bytes.length!==Number(row.byte_size)||hash(bytes)!==row.sha256)throw new MigrationError('DATABASE_CORRUPT');
    }
    for(const [table, column] of [['workflow_versions','artifact_path'],['drafts','artifact_path'], ...(version>=5?[['script_versions','source_ref']]:[])] as string[][]) {
      for(const row of db.prepare(`SELECT "${column}" AS path FROM "${table}"`).all()) {
        const relative=String(row.path); if(!/^artifacts\/(trees|scripts)\/[a-f0-9]{64}\/tree\.json$/.test(relative))throw new MigrationError('INVALID_PATH');
        const bytes=readFileSync(safe(root,relative));
        const digest=relative.split('/').find(p=>/^[a-f0-9]{64}$/.test(p));
        if(!digest||hash(bytes)!==digest)throw new MigrationError('DATABASE_CORRUPT');
      }
    }
    if(version>=2)for(const row of db.prepare('SELECT snapshot_path FROM runs WHERE snapshot_path IS NOT NULL').all()) {
      const relative=String(row.snapshot_path);if(!/^artifacts\/trees\/[a-f0-9]{64}\/tree\.json$/.test(relative)||fileHash(safe(root,relative))!==relative.split('/')[2])throw new MigrationError('DATABASE_CORRUPT');
    }
  }
  return version;
}
export function encode(value: unknown): unknown {
  if(typeof value==='bigint') return ['integer',String(value)];
  if(typeof value==='number') return ['real',Object.is(value,-0)?'-0':String(value)];
  if(value instanceof Uint8Array) return ['blob',Buffer.from(value).toString('base64')];
  if(value===null)return ['null'];return ['text',value];
}
export function databaseFingerprint(db: DatabaseSync): string {
  const digest:string[]=[];
  db.exec('BEGIN');
  try {
    const objects=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    digest.push(canonical({version:databaseVersion(db),objects}));
    for(const table of objects.filter(r=>r.type==='table')) {
      const statement=db.prepare(`SELECT * FROM "${String(table.name).replaceAll('"','""')}"`); statement.setReadBigInts(true);
      const rows=statement.all().map(row=>canonical(Object.entries(row).map(([key,value])=>[key,encode(value)]))).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
      digest.push(canonical([table.name,rows]));
    }
    db.exec('COMMIT');
  } catch(error){ db.exec('ROLLBACK');throw error; }
  return hash(canonical(digest));
}
