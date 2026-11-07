import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Bootstrap} from '../src/server/bootstrap.js';
import {DatabaseSync} from 'node:sqlite';
import {defaultBridgeConfig} from '../src/migrations/config.js';
import {until} from './helpers.js';
import {currentVersion} from '../src/migrations/frozen.js';

function workspace(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'orchard-migration-review-')),instances:Bootstrap[]=[],closed=new Set<Bootstrap>();
 const close=async(bootstrap:Bootstrap)=>{if(closed.has(bootstrap))return;await bootstrap.close();bootstrap.release();closed.add(bootstrap);};
 t.after(async()=>{for(const instance of instances.reverse())await close(instance);rmSync(root,{recursive:true,force:true});});
 return {root,close,open(){const bootstrap=new Bootstrap(root,7441);instances.push(bootstrap);return bootstrap;}};
}
function current(root:string){
 const db=new DatabaseSync(join(root,'workbench.db'));try{db.exec(readFileSync(new URL(`./fixtures/migrations/database/v${currentVersion}.sql`,import.meta.url),'utf8'));}finally{db.close();}
 mkdirSync(join(root,'config'));writeFileSync(join(root,'config/web-bridge.json'),JSON.stringify(defaultBridgeConfig()));
}

test('M21 shutdown settles every concurrent rehearsal before releasing the directory lease',async t=>{
 const w=workspace(t);current(w.root);const bootstrap=w.open();await bootstrap.start(async()=>{});
 const internal=bootstrap as unknown as {run(command:string):Promise<unknown>};let settled=0;
 const pending=[internal.run('plan'),internal.run('plan')].map(promise=>promise.then(()=>{settled++;},()=>{settled++;}));
 try{await bootstrap.close();assert.equal(settled,2);}finally{await Promise.all(pending);}
});

test('M21 first startup recovers only empty or unpublished initialization traces',async t=>{
 for(const trace of ['stale-lock','empty-migrations','partial-intent','empty-work']){
  const w=workspace(t);writeFileSync(join(w.root,'workbench.lock'),'2147483647');
  if(trace!=='stale-lock')mkdirSync(join(w.root,'migrations'));
  if(trace==='partial-intent')writeFileSync(join(w.root,`migrations/initialization.json.tmp-${randomUUID()}`),'{"formatVersion":');
  if(trace==='empty-work')mkdirSync(join(w.root,`runtime/initialization/${randomUUID()}`),{recursive:true});
  const bootstrap=w.open();await bootstrap.start(async()=>{});assert.equal(bootstrap.status().state,'ready',trace);
  const db=new DatabaseSync(join(w.root,'workbench.db'),{readOnly:true});try{assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,currentVersion);}finally{db.close();}
 }
});

test('M09 unrecognized initialization contents still block without creating formal data',async t=>{
 for(const directory of ['migrations',`runtime/initialization/${randomUUID()}`]){
  const w=workspace(t);mkdirSync(join(w.root,directory),{recursive:true});const path=join(w.root,directory,'unrecognized.dat');writeFileSync(path,'external bytes');
  const bootstrap=w.open();await bootstrap.start(async()=>{});assert.equal(bootstrap.status().state,'blocked');assert.equal(existsSync(join(w.root,'workbench.db')),false);assert.equal(readFileSync(path,'utf8'),'external bytes');
 }
});

test('M21 unpublished operation records are ignored during retry and discarded on restart',async t=>{
 const w=workspace(t);current(w.root);const bootstrap=w.open();let attempts=0;await bootstrap.start(async()=>{if(++attempts===1)throw new Error('initialization fixture');});
 assert.equal(bootstrap.status().state,'initialization_failed');mkdirSync(join(w.root,'migrations/operations'));
 const temporary=()=>{const path=join(w.root,`migrations/operations/${randomUUID()}.json.tmp-${randomUUID()}`);writeFileSync(path,'{"accepted":');return path;};
 const beforeRetry=temporary();await bootstrap.operation('initialize',randomUUID());await until(()=>bootstrap.ready);assert.equal(existsSync(beforeRetry),false);await w.close(bootstrap);
 const beforeRestart=temporary(),restarted=w.open();await restarted.start(async()=>{});assert.equal(restarted.ready,true);assert.equal(existsSync(beforeRestart),false);
});

test('M09 unknown operation files remain untouched and block startup',async t=>{
 const w=workspace(t);current(w.root);const bootstrap=w.open();await bootstrap.start(async()=>{});await w.close(bootstrap);
 mkdirSync(join(w.root,'migrations/operations'));const unknown=join(w.root,'migrations/operations/unknown.json');writeFileSync(unknown,'unrecognized bytes');
 const restarted=w.open();await restarted.start(async()=>{});assert.equal(restarted.status().state,'blocked');assert.equal(restarted.status(true).error?.code,'UNKNOWN_PROTOCOL');assert.equal(readFileSync(unknown,'utf8'),'unrecognized bytes');
});
