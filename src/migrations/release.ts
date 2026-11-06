import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseDigest,releaseFiles,manifestChecksum} from './frozen.js';
import {canonical} from './journal.js';
import {MigrationError} from './types.js';
let checked=false;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function assertReleaseIntegrity(){
 if(checked)return;
 try{
  const executionRoot=dirname(dirname(fileURLToPath(import.meta.url))),packageRoot=dirname(executionRoot);
  const source=import.meta.url.endsWith('.ts');
  const envelope=JSON.parse(readFileSync(resolve(source?packageRoot:executionRoot,source?'docs/features/2026-11-06-data-migration/migration-manifest.json':'migration-integrity.json'),'utf8'));
  if((source?envelope.contentDigest:envelope.releaseDigest)!==releaseDigest)throw new Error('Release digest differs');
  if(source){const {bundleChecksum,...manifestContent}=envelope;if(digest(canonical(manifestContent))!==manifestChecksum)throw new Error('Changed source manifest');}
  const files:Record<string,string>=source?releaseFiles:envelope.files;
  if(!files||Object.keys(files).length<10||(!source&&envelope.formatVersion!==1))throw new Error('Missing integrity envelope');
  if(!source&&['migrations/worker.js','migrations/runner.js','migrations/frozen.js','server/main.js','web/index.html'].some(path=>!Object.hasOwn(files,path)))throw new Error('Incomplete integrity envelope');
  const base=source?packageRoot:executionRoot;
  for(const [path,expected] of Object.entries(files)){
   const absolute=resolve(base,path),rel=relative(base,absolute);
   if(isAbsolute(path)||rel.startsWith('..')||isAbsolute(rel)||digest(readFileSync(absolute))!==expected)throw new Error('Changed release file');
  }
  if(source&&digest(readFileSync(resolve(packageRoot,'src/migrations/frozen.ts')))!==envelope.bundleChecksum)throw new Error('Changed generated bundle');
  checked=true;
 }catch{throw new MigrationError('MIGRATION_PACKAGE_CHANGED');}
}
