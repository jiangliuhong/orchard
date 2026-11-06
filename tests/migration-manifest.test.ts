import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {transformSync} from 'esbuild';
const root=new URL('../',import.meta.url),manifestPath='docs/features/2026-11-06-data-migration/migration-manifest.json';
const manifest=JSON.parse(readFileSync(new URL(manifestPath,root),'utf8'));
test('release locks independent historical baselines and executable dependencies separately from schema approval',()=>{
 const approval=JSON.parse(readFileSync(new URL(manifest.schemaApproval,root),'utf8'));
 assert.equal(manifest.status,'release_locked');assert.equal(manifest.review.contentDigest,approval.contentDigest);assert.notEqual(manifest.contentDigest,approval.contentDigest);
 for(const entry of manifest.entries)for(const path of ['src/migrations/mapping.ts','src/migrations/runner.ts','src/migrations/validators.ts','src/migrations/questions.ts'])assert.ok(entry.files.includes(path),path);
 for(const path of ['src/server/bootstrap.ts','tests/fixtures/migrations/database/provenance.json','src/web/Bootstrap.tsx','vite.config.ts','src/domain/validation.ts'])assert.ok(manifest.fileChecksums[path],path);
 assert.equal(manifest.entries.length,7);
});
test('locked release passes approval verification and deterministic bundle generation',()=>{
 const result=execFileSync(process.execPath,['scripts/check-migration-manifest.mjs','--require-review'],{cwd:root,encoding:'utf8'});assert.match(result,/Verified 7 locked migration declarations/);
 execFileSync(process.execPath,['scripts/generate-migration-bundle.mjs','--check'],{cwd:root,encoding:'utf8'});
});
test('compiled integrity envelopes must retain every required migration artifact',t=>{
 const copy=mkdtempSync(join(tmpdir(),'orchard-compiled-check-'));t.after(()=>rmSync(copy,{recursive:true,force:true}));
 const contents:Record<string,string>={
  'migrations/release.js':transformSync(readFileSync(new URL('src/migrations/release.ts',root),'utf8'),{loader:'ts',format:'esm'}).code,
  'migrations/frozen.js':"export const releaseDigest='fixture',releaseFiles={},manifestChecksum='fixture';",
  'migrations/journal.js':'export const canonical=JSON.stringify;',
  'migrations/types.js':'export class MigrationError extends Error {}',
  'migrations/worker.js':'','migrations/runner.js':'','server/main.js':'','web/index.html':'',
  ...Object.fromEntries(Array.from({length:6},(_,i)=>[`web/asset-${i}.js`,''])),
 };
 writeFileSync(join(copy,'package.json'),'{"type":"module"}');
 for(const [path,value] of Object.entries(contents)){mkdirSync(dirname(join(copy,'dist',path)),{recursive:true});writeFileSync(join(copy,'dist',path),value);}
 const files=Object.fromEntries(Object.entries(contents).map(([path,value])=>[path,createHash('sha256').update(value).digest('hex')]));
 const check=()=>spawnSync(process.execPath,['--input-type=module','-e',"import {assertReleaseIntegrity} from './dist/migrations/release.js';assertReleaseIntegrity();"],{cwd:copy,encoding:'utf8'});
 const save=(files:Record<string,string>)=>writeFileSync(join(copy,'dist/migration-integrity.json'),JSON.stringify({formatVersion:1,releaseDigest:'fixture',files}));
 save(files);assert.equal(check().status,0);
 for(const required of ['migrations/worker.js','migrations/runner.js','migrations/frozen.js','server/main.js','web/index.html']){const incomplete={...files};delete incomplete[required];save(incomplete);const result=check();assert.notEqual(result.status,0,required);assert.match(result.stderr,/MIGRATION_PACKAGE_CHANGED/);}
});
test('declaration and resource scope changes invalidate checksums',()=>{
 execFileSync(process.execPath,['--input-type=module','-e',`
 import assert from 'node:assert/strict';
 import {checkManifest,entryChecksum,canonical} from './scripts/check-migration-manifest.mjs';
 const entry=checkManifest().entries[0];
 assert.notEqual(entryChecksum({...entry,to:99}),entry.checksum);
 assert.notEqual(entryChecksum({...entry,files:[]}),entry.checksum);
 assert.notEqual(entryChecksum({...entry,questions:[{id:'new'}]}),entry.checksum);
 assert.equal(entryChecksum({...entry,reviewReference:'approval remains separate'}),entry.checksum);
 assert.equal(canonical({z:1,a:[true,null]}),'{'+'"a":[true,null],"z":1}');
 assert.equal(canonical({'\\u{10000}':1,'\\ue000':2}),'{'+'"\\ue000":2,"\\u{10000}":1}');
 `],{cwd:root,encoding:'utf8'});
});
test('isolated mutations of reviewed SQL, local helpers, generated bundles and lock scope fail release checks',t=>{
 const copy=mkdtempSync(join(tmpdir(),'orchard-release-check-'));t.after(()=>rmSync(copy,{recursive:true,force:true}));
 const paths=new Set([manifestPath,'src/migrations/frozen.ts',...Object.keys(manifest.fileChecksums)]);
 for(const path of paths){mkdirSync(dirname(join(copy,path)),{recursive:true});copyFileSync(new URL(path,root),join(copy,path));}
 const check=()=>spawnSync(process.execPath,['scripts/check-migration-manifest.mjs','--require-review'],{cwd:copy,encoding:'utf8'});
 assert.equal(check().status,0);
 for(const [path,message] of [['src/migrations/mapping.ts',/Frozen content changed/],['src/migrations/frozen.ts',/Generated migration bundle changed/],['src/web/Bootstrap.tsx',/Local dependency changed/],['vite.config.ts',/Local dependency changed/],['docs/features/2026-11-06-data-migration/sql/db.v1-v2.sql',/Approved schema\/protocol bytes changed/]] as const){
  const file=join(copy,path),original=readFileSync(file);writeFileSync(file,Buffer.concat([original,Buffer.from('\n-- changed bytes\n')]));const result=check();assert.notEqual(result.status,0);assert.match(result.stderr,message);writeFileSync(file,original);
 }
 const altered=structuredClone(manifest);delete altered.fileChecksums['src/migrations/runner.ts'];writeFileSync(join(copy,manifestPath),JSON.stringify(altered));assert.match(check().stderr,/Incomplete local dependency lock/);
 writeFileSync(join(copy,manifestPath),JSON.stringify(manifest));
 writeFileSync(join(copy,'src/web/Bootstrap.tsx'),readFileSync(join(copy,'src/web/Bootstrap.tsx'),'utf8')+'\n// a subsequent UI release\n');
 execFileSync(process.execPath,['scripts/lock-migration-release.mjs','--refresh-unpublished'],{cwd:copy});assert.equal(check().status,0);
 const next=JSON.parse(readFileSync(join(copy,manifestPath),'utf8'));assert.notEqual(next.contentDigest,manifest.contentDigest);assert.deepEqual(next.entries.map((entry:{id:string;checksum:string})=>({id:entry.id,checksum:entry.checksum})),manifest.entries.map((entry:{id:string;checksum:string})=>({id:entry.id,checksum:entry.checksum})));
});
