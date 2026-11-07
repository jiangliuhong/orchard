import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { manifestPath, sha256, canonical } from './check-migration-manifest.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function generateBundle(manifest){
 const sql={},baselines={};const {bundleChecksum,...manifestContent}=manifest;
 const currentVersion=Math.max(...manifest.entries.filter(entry=>entry.kind==='initialization').map(entry=>entry.to));
 for(let version=1;version<=currentVersion;version++){
  if(version<currentVersion)sql[version]=readFileSync(resolve(root,`docs/features/2026-11-06-data-migration/sql/db.v${version}-v${version+1}.sql`),'utf8');
  const db=new DatabaseSync(':memory:');
  try{db.exec(readFileSync(resolve(root,`tests/fixtures/migrations/database/v${version}.sql`),'utf8'));baselines[version]={objects:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()};}finally{db.close();}
 }
 const declarations=manifest.entries.filter(entry=>entry.kind!=='initialization').sort((left,right)=>left.kind===right.kind?left.from-right.from:left.kind==='database'?-1:1).map(({id,kind,from,to,requires,checksum,summary,affectedResources,questions})=>({id,kind,from,to,requires,checksum,summary,affectedResources,questions}));
 const initializationSql=readFileSync(resolve(root,`docs/features/2026-11-06-data-migration/sql/db.initialize-v${currentVersion}.sql`),'utf8');
 return '// Generated from the locked release manifest and historical declarative fixtures. Do not edit.\n'+
  "import type { MigrationDeclaration } from './types.js';\n"+
  `export const currentVersion = ${currentVersion};\n`+
  `export const sql: Record<number,string> = ${JSON.stringify(sql,null,2)};\n`+
  `export const initializationSql = ${JSON.stringify(initializationSql)};\n`+
  `export const baselines: Record<number,{objects: Record<string,unknown>[]}> = ${JSON.stringify(baselines,null,2)};\n`+
  `export const declarations: MigrationDeclaration[] = ${JSON.stringify(declarations,null,2)};\n`+
  `export const approval = ${JSON.stringify(manifest.review)};\n`+
  `export const releaseDigest = ${JSON.stringify(manifest.contentDigest)};\n`+
  `export const manifestChecksum = ${JSON.stringify(sha256(canonical(manifestContent)))};\n`+
  `export const releaseFiles: Record<string,string> = ${JSON.stringify(manifest.fileChecksums??{},null,2)};\n`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const result=generateBundle(JSON.parse(readFileSync(resolve(root,manifestPath),'utf8'))),path=resolve(root,'src/migrations/frozen.ts');
 if(process.argv.includes('--write'))writeFileSync(path,result);
 else if(readFileSync(path,'utf8')!==result){console.error('Frozen migration bundle differs from the locked manifest or historical fixtures');process.exitCode=1;}
 else console.log('Frozen migration bundle matches its locked inputs');
}
