import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export const manifestPath='docs/features/2026-11-06-data-migration/migration-manifest.json';
export const historicalReleasePath='docs/features/2026-11-06-data-migration/release-v6.json';
export const historicalReleasePaths=[historicalReleasePath,'docs/features/2026-11-06-data-migration/release-v9.json','docs/features/2026-11-06-data-migration/release-v10.json'];
export function historicalReleases(){
 return historicalReleasePaths.filter(path=>existsSync(resolve(root,path))).map(path=>JSON.parse(resourceBytes(path)));
}
export function historicalRelease(){
 return historicalReleases().at(-1)??null;
}
export function canonical(value){
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 return JSON.stringify(value);
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function resourceBytes(path){
 const absolute=resolve(root,path),rel=relative(root,absolute);
 if(isAbsolute(path)||rel.startsWith('..')||isAbsolute(rel))throw new Error('Manifest resource escapes repository');
 return readFileSync(absolute);
}
export function entryChecksum(entry){
 const {checksum,reviewReference,...declaration}=entry;
 const historical=historicalReleases().find(release=>release.entries.some(candidate=>candidate.id===entry.id&&canonical(candidate.files)===canonical(entry.files))),prior=historical?.entries.find(candidate=>candidate.id===entry.id);
 const preserve=prior&&canonical(prior.files)===canonical(entry.files);
 return sha256(canonical({declaration,resources:entry.files.map(path=>({path,sha256:preserve?historical.fileChecksums[path]:sha256(resourceBytes(path))}))}));
}
const walk=path=>readdirSync(resolve(root,path),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(`${path}/${entry.name}`):[`${path}/${entry.name}`]);
export const migrationFiles=()=>walk('src/migrations').filter(path=>path!=='src/migrations/frozen.ts');
export function releaseFiles(entries,approvalPath='docs/features/2026-11-06-data-migration/schema-approval-v8.json'){
 return [...new Set([...walk('src').filter(path=>path!=='src/migrations/frozen.ts'),...walk('scripts'),...walk('tests/fixtures/migrations'),...entries.flatMap(entry=>entry.files),
  approvalPath,'docs/features/2026-11-06-data-migration/schema-review.md','docs/features/2026-11-06-data-migration/schema-approval.json','docs/features/2026-11-06-data-migration/schema-approval-v8.json',...historicalReleasePaths,'package.json','pnpm-lock.yaml','tsconfig.json','tsconfig.server.json','vite.config.ts','index.html'])].sort();
}
export function contentDigest(manifest){
 const entries=manifest.entries.map(({id,checksum})=>({id,checksum}));
 return sha256(canonical(manifest.status==='release_locked'?{formatVersion:1,entries,schemaApproval:manifest.schemaApproval,fileChecksums:manifest.fileChecksums}:entries));
}
export function checkManifest({requireReview=false}={}){
 const manifest=JSON.parse(resourceBytes(manifestPath));
 if(manifest.formatVersion!==1||manifest.status!=='release_locked')throw new Error('Executable migrations require a locked release manifest');
 const approved=JSON.parse(resourceBytes(manifest.schemaApproval));
 const histories=historicalReleases();
 if(histories.length!==historicalReleasePaths.length)throw new Error('Missing historical release archive');
 for(const historical of histories){
  if(historical.contentDigest!==contentDigest(historical))throw new Error('Invalid historical release archive');
  for(const entry of historical.entries) {
   if(canonical(manifest.entries.find(candidate=>candidate.id===entry.id))!==canonical(entry))throw new Error(`Historical migration identity changed: ${entry.id}`);
   for(const path of entry.files.filter(path=>path.endsWith('.sql'))) {
    if(sha256(resourceBytes(path))!==historical.fileChecksums[path])throw new Error(`Approved schema/protocol bytes changed: ${entry.id}`);
   }
  }
 }
 if(approved.formatVersion!==1||approved.status!=='review_candidate'||approved.contentDigest!==contentDigest(approved))throw new Error('Invalid schema approval archive');
 if(approved.review.status!=='approved'||!approved.review.reviewer||!approved.review.date||approved.review.contentDigest!==approved.contentDigest||canonical(manifest.review)!==canonical(approved.review))throw new Error('Schema approval does not match the reviewed archive');
 for(const entry of approved.entries)if(entryChecksum(entry)!==entry.checksum)throw new Error(`Approved schema/protocol bytes changed: ${entry.id}`);
 const ids=new Set(),allFiles=new Set();
 for(const entry of manifest.entries){
  if(ids.has(entry.id))throw new Error(`Duplicate migration ID: ${entry.id}`);ids.add(entry.id);
  if(entry.checksum!==entryChecksum(entry))throw new Error(`Frozen content changed: ${entry.id}`);
  const prior=approved.entries.find(candidate=>candidate.id===entry.id);
  if(!prior)throw new Error(`Unreviewed migration ID: ${entry.id}`);
  for(const field of ['kind','from','to','requires','summary','affectedResources','questions','requiresSchemaReview','verification','reviewReference'])if(canonical(entry[field])!==canonical(prior[field]))throw new Error(`Reviewed declaration changed: ${entry.id}/${field}`);
  if(requireReview&&entry.requiresSchemaReview&&(!entry.reviewReference||!resourceBytes(entry.reviewReference.split('#')[0]).length))throw new Error(`Schema review missing: ${entry.id}`);
  for(const question of entry.questions)if(question.type==='secret'&&question.default!==undefined)throw new Error('Secret defaults must not enter a release');
  for(const path of entry.files)allFiles.add(path);
 }
 if(ids.size!==approved.entries.length)throw new Error('Release drops an approved migration ID');
 for(const entry of manifest.entries)for(const required of entry.requires)if(!ids.has(required))throw new Error(`Missing migration dependency: ${required}`);
 if(canonical(releaseFiles(approved.entries,manifest.schemaApproval))!==canonical(Object.keys(manifest.fileChecksums).sort())||[...allFiles].some(path=>!manifest.fileChecksums[path]))throw new Error('Incomplete local dependency lock');
 for(const path of Object.keys(manifest.fileChecksums))if(sha256(resourceBytes(path))!==manifest.fileChecksums[path])throw new Error(`Local dependency changed: ${path}`);
 if(contentDigest(manifest)!==manifest.contentDigest)throw new Error('Manifest content digest mismatch');
 if(sha256(resourceBytes('src/migrations/frozen.ts'))!==manifest.bundleChecksum)throw new Error('Generated migration bundle changed');
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const manifest=checkManifest({requireReview:process.argv.includes('--require-review')});console.log(`Verified ${manifest.entries.length} locked migration declarations; ${manifest.contentDigest}`);}
 catch(error){console.error(error.message);process.exitCode=1;}
}
