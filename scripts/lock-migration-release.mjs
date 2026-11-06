// Explicit preparation tool for this release before publication; never run by build/start.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,entryChecksum,contentDigest,sha256,manifestPath,migrationFiles,releaseFiles} from './check-migration-manifest.mjs';
import {generateBundle} from './generate-migration-bundle.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),approvalPath='docs/features/2026-11-06-data-migration/schema-approval.json';
const old=JSON.parse(readFileSync(resolve(root,manifestPath),'utf8'));
if(old.status==='release_locked'&&!process.argv.includes('--refresh-unpublished'))throw new Error('Release is locked; unpublished development refresh requires --refresh-unpublished');
const approved=JSON.parse(readFileSync(resolve(root,approvalPath),'utf8'));
if(approved.review.status!=='approved'||approved.review.contentDigest!==approved.contentDigest||contentDigest(approved)!==approved.contentDigest)throw new Error('Schema approval is missing');
for(const entry of approved.entries)if(entryChecksum(entry)!==entry.checksum)throw new Error(`Reviewed bytes changed: ${entry.id}`);
// A UI/business release must not rewrite the identity of an already executed migration.
const shared=migrationFiles();
const manifest={...approved,status:'release_locked',schemaApproval:approvalPath,checksumContract:'sha256(canonical declaration + all named source resources); schema approval remains bound to the original candidate digest; generated bundle and compiled package have separate integrity envelopes',fileChecksums:{},bundleChecksum:''};
manifest.entries=approved.entries.map(entry=>{const next={...entry,files:[...new Set([...entry.files,...shared])].sort()};next.checksum=entryChecksum(next);return next;});
for(const path of releaseFiles(approved.entries))manifest.fileChecksums[path]=sha256(readFileSync(resolve(root,path)));
manifest.contentDigest=contentDigest(manifest);
const bundle=generateBundle(manifest);manifest.bundleChecksum=sha256(bundle);
writeFileSync(resolve(root,'src/migrations/frozen.ts'),bundle);writeFileSync(resolve(root,manifestPath),JSON.stringify(manifest,null,2)+'\n');
console.log(`Locked ${manifest.entries.length} reviewed declarations for release ${manifest.contentDigest}; schema approval ${approved.contentDigest}`);
