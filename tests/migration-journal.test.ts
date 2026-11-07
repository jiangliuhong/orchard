import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {durable,copyDurable,removeDurable} from '../src/migrations/journal.js';

test('durable publication flushes file bytes before rename and the parent after rename; failed flush cannot replace the old file',()=>{
 const root=fs.mkdtempSync(join(tmpdir(),'orchard-journal-')),target=join(root,'state.json'),copy=join(root,'copy.json');
 const original={openSync:fs.openSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync,unlinkSync:fs.unlinkSync};
 const paths=new Map<number,string>(),events:string[]=[];let fail=false;
 durable(target,'original');
 try{
  fs.openSync=((path,...args)=>{const fd=(original.openSync as Function)(path,...args);paths.set(fd,String(path));return fd;}) as typeof fs.openSync;
  fs.fsyncSync=(fd=>{const path=paths.get(fd)!;events.push(`flush:${path}`);if(fail&&path.startsWith(target+'.tmp-'))throw Object.assign(new Error('simulated flush failure'),{code:'EIO'});return original.fsyncSync(fd);}) as typeof fs.fsyncSync;
  fs.renameSync=((from,to)=>{assert.ok(events.includes(`flush:${from}`),'file must be flushed before publication');events.push(`rename:${to}`);return original.renameSync(from,to);}) as typeof fs.renameSync;
  fs.unlinkSync=(path=>{events.push(`unlink:${path}`);return original.unlinkSync(path);}) as typeof fs.unlinkSync;
  syncBuiltinESMExports();durable(target,'committed');
  assert.equal(fs.readFileSync(target,'utf8'),'committed');assert.ok(events.indexOf(`flush:${root}`)>events.indexOf(`rename:${target}`));
  events.length=0;copyDurable(target,copy);assert.ok(events.indexOf(`flush:${copy}`)<events.indexOf(`flush:${root}`));
  events.length=0;removeDurable(copy);assert.ok(events.indexOf(`unlink:${copy}`)<events.indexOf(`flush:${root}`));
  fail=true;assert.throws(()=>durable(target,'unflushed'),/simulated flush failure/);assert.equal(fs.readFileSync(target,'utf8'),'committed');
 }finally{Object.assign(fs,original);syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
});
