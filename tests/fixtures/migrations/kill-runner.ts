import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { DirectoryLease } from '../../../src/migrations/lock.js';
import { readJson, safe } from '../../../src/migrations/journal.js';
import { execute, initializeData, saveJob, publishJob } from '../../../src/migrations/runner.js';
import type { Job } from '../../../src/migrations/types.js';
const [root,boundary,kind]=process.argv.slice(2) as [string,string,string];
const lease=DirectoryLease.acquire(root);
const point=(name:string)=>{if(name===boundary){process.send!(name);process.kill(process.pid,'SIGSTOP');}if(kind==='restore'&&name==='install:workbench.db:after')throw new Error('test restoration');};
if(kind==='initialize'||kind==='optional')initializeData(root,kind==='initialize'?'new_install':'optional_config',randomUUID(),point);
else if(kind==='accept')publishJob(root,readJson<Job>(safe(root,'runtime/test-accept.json')),{secret:'test-private'},point);
else{const id=readdirSync(safe(root,'migrations/jobs'))[0];const job=readJson<Job>(safe(root,`migrations/jobs/${id}/state.json`));if(boundary.startsWith('state:accepted:'))saveJob(root,job,point);execute(root,job,point);}
lease.release();
