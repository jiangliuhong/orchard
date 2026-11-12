// Explicit preparation tool for this release before publication; never run by build/start.
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonical,entryChecksum,contentDigest,sha256,manifestPath,migrationFiles,releaseFiles,historicalRelease} from './check-migration-manifest.mjs';
import {generateBundle} from './generate-migration-bundle.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const old=JSON.parse(readFileSync(resolve(root,manifestPath),'utf8'));
const approvalPath=process.argv.includes('--workspace-v11')||old.targetDatabaseVersion===11
 ?'docs/features/2026-11-12-agent-workspace-projection/schema-approval-v11.json'
 :'docs/features/2026-11-09-dictionaries/schema-approval-v10.json';
if(old.status==='release_locked'&&!process.argv.includes('--refresh-unpublished'))throw new Error('Release is locked; unpublished development refresh requires --refresh-unpublished');
const approved=JSON.parse(readFileSync(resolve(root,approvalPath),'utf8'));
if(approved.review.status!=='approved'||approved.review.contentDigest!==approved.contentDigest||contentDigest(approved)!==approved.contentDigest)throw new Error('Schema approval is missing');
for(const entry of approved.entries)if(entryChecksum(entry)!==entry.checksum)throw new Error(`Reviewed bytes changed: ${entry.id}`);
// A UI/business release must not rewrite the identity of an already executed migration.
const shared=migrationFiles();
const manifest={...approved,status:'release_locked',schemaApproval:approvalPath,checksumContract:'Historical migration identities retain their archived source digests; new identities hash canonical declarations and named source resources. Reviewed SQL remains immutable. Current execution code, generated bundle and compiled package are locked in separate release integrity envelopes.',fileChecksums:{},bundleChecksum:''};
const historical=historicalRelease();
manifest.entries=approved.entries.map(entry=>{const prior=historical?.entries.find(candidate=>candidate.id===entry.id);if(prior)return prior;const next={...entry,files:[...new Set([...entry.files,...shared])].sort()};next.checksum=entryChecksum(next);return next;});
for(const path of releaseFiles(approved.entries,approvalPath))manifest.fileChecksums[path]=sha256(readFileSync(resolve(root,path)));
manifest.contentDigest=contentDigest(manifest);
const bundle=generateBundle(manifest);manifest.bundleChecksum=sha256(bundle);
writeFileSync(resolve(root,'src/migrations/frozen.ts'),bundle);writeFileSync(resolve(root,manifestPath),JSON.stringify(manifest,null,2)+'\n');
console.log(`Locked ${manifest.entries.length} reviewed declarations for release ${manifest.contentDigest}; schema approval ${approved.contentDigest}`);
