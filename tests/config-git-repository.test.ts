import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, access, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitRepositoryService, validateGitRemote, type GitRepositoryOptions } from '../src/config-git/repository.js';

const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
async function fixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),'orchard-git-test-'));t.after(async()=>{const {rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true});});
  const remote=join(root,'remote.git');await mkdir(remote);git(remote,'init','--bare','--initial-branch=main');
  const options={testTransport:()=>remote,validateSnapshot:(files:Record<string,string>)=>{assert.equal(JSON.parse(files['manifest.json']).formatVersion,1);}};
  const service=(name:string,extra:GitRepositoryOptions={})=>new GitRepositoryService(join(root,name),{...options,...extra});
  return {root,remote,service};
}
const files=(text:string)=>({'manifest.json':'{"formatVersion":1}\n','settings.txt':text});
async function bind(s:GitRepositoryService){return s.bind({remoteUrl:'https://example.com/config.git',branch:'main',identity:{name:'Fixture',email:'fixture@example.com'}});}
async function commit(s:GitRepositoryService,text:string,push=false,regenerate=false){const p=await s.previewCommit({files:files(text),revision:'r1',message:text,push,regenerate});return s.confirmCommit({token:p.token,revision:'r1',requestId:crypto.randomUUID()});}

test('production URL validation rejects file/local/options/credentials',()=>{
  for(const url of ['/tmp/a','file:///tmp/a','-x','ext::sh','https://user:token@example.com/x','https://token@example.com/x','ssh://user:token@example.com/x']) assert.throws(()=>validateGitRemote(url));
  for(const url of ['https://example.com/x','git@example.com:team/x.git','ssh://git@example.com/team/x'])assert.equal(validateGitRemote(url),url);
});
test('empty bind, preview confirmation, idempotency, fixed SHA, no-op, fetch and unbind retain copies',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a);assert.equal(b.snapshotState,'empty');
  assert.equal((await a.checkRemote(b.remoteUrl)).pushPermission,'unverified');
  const p=await a.previewCommit({files:files('first'),revision:'r1',message:'first',push:true});
  await assert.rejects(a.confirmCommit({token:p.token,revision:'changed',requestId:'stale'}),{code:'PREVIEW_EXPIRED'});
  const request={token:p.token,revision:'r1',requestId:'first'},r=await a.confirmCommit(request);assert.equal(r.pushed,true);assert.equal(r.committed,true);assert.deepEqual(await a.confirmCommit(request),r);
  assert.equal((await a.readSnapshot(r.sha!))['settings.txt'],'first');assert.equal((await commit(a,'first')).committed,false);
  await commit(a,'second');assert.equal((await a.readSnapshot(r.sha!))['settings.txt'],'first');assert.equal((await a.history()).commits.length,2);
  assert.equal((await a.status()).ahead,1);await a.push();assert.equal((await a.status()).ahead,0);
  await a.unbind();assert.equal(await a.getBinding(),null);await access(b.repositoryPath);
  const rebound=await bind(a);assert.notEqual(rebound.id,b.id);
});
test('dirty worktree and staged changes block operations without cleanup',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a);await commit(a,'first');
  const path=join(b.repositoryPath,'orchard-config/settings.txt');await writeFile(path,'external');
  await assert.rejects(commit(a,'second'),{code:'DIRTY_REPOSITORY'});assert.equal(await readFile(path,'utf8'),'external');
  await writeFile(path,'first');git(b.repositoryPath,'update-index','--force-remove','orchard-config/settings.txt');
  await assert.rejects(a.fetch(),{code:'DIRTY_REPOSITORY'});
});
test('divergence regeneration preserves old commits and remote outside files; preview becomes stale',async t=>{
  const f=await fixture(t),a=f.service('a');await bind(a);await commit(a,'initial',true);
  const b=f.service('b'),binding=await bind(b);await commit(a,'local');
  await writeFile(join(binding.repositoryPath,'README.md'),'outside survives\n');git(binding.repositoryPath,'add','README.md');git(binding.repositoryPath,'commit','-m','outside');await commit(b,'remote',true);
  await a.fetch();assert.equal((await a.status()).diverged,true);await assert.rejects(a.push(),{code:'REMOTE_DIVERGED'});
  const old=(await a.status()).head;const p=await a.previewCommit({files:files('regenerated'),revision:'r',message:'regenerated',push:true,regenerate:true});
  assert.equal((await a.status()).head,old);assert.equal(p.diff.find(x=>x.path==='settings.txt')?.before,'remote');
  const result=await a.confirmCommit({token:p.token,revision:'r',requestId:'regenerated'});assert.equal(result.pushed,true);assert.ok(result.backupRef);
  const ab=(await a.getBinding())!;assert.equal(git(ab.repositoryPath,'rev-parse',result.backupRef!),old);assert.equal(await readFile(join(ab.repositoryPath,'README.md'),'utf8'),'outside survives\n');
  const stale=await a.previewCommit({files:files('stale'),revision:'r',message:'stale',push:true});await commit(b,'remote update',false); // b is behind: explicit regeneration
  const bp=await b.previewCommit({files:files('new remote'),revision:'r',message:'new remote',push:true,regenerate:true});await b.confirmCommit({token:bp.token,revision:'r',requestId:'new-remote'});
  await assert.rejects(a.confirmCommit({token:stale.token,revision:'r',requestId:'stale-remote'}),{code:'PREVIEW_EXPIRED'});
});
test('hooks and configured filters are never executed',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a),sentinel=join(f.root,'EXECUTED');
  await mkdir(join(b.repositoryPath,'.git/hooks'),{recursive:true});await mkdir(join(b.repositoryPath,'.git/info'),{recursive:true});
  const hook=join(b.repositoryPath,'.git/hooks/pre-commit');await writeFile(hook,`#!/bin/sh\ntouch '${sentinel}'\n`);await chmod(hook,0o755);
  git(b.repositoryPath,'config','filter.evil.clean',`touch '${sentinel}'`);git(b.repositoryPath,'config','filter.evil.smudge',`touch '${sentinel}'`);
  await writeFile(join(b.repositoryPath,'.git/info/attributes'),'* filter=evil\n');
  await commit(a,'safe',true);await a.status();await assert.rejects(access(sentinel));
});
test('local SSH command override and global ext URL rewrite cannot execute commands',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a),sentinel=join(f.root,'TRANSPORT_EXECUTED');
  git(b.repositoryPath,'config','core.sshCommand',`touch '${sentinel}'`);
  const record=join(f.root,'a/config-git/binding.json');await writeFile(record,JSON.stringify({...b,remoteUrl:'ssh://git@127.0.0.1:1/config.git'}));
  const production=new GitRepositoryService(join(f.root,'a'),{timeoutMs:2000});await assert.rejects(production.fetch());await assert.rejects(access(sentinel));
  const home=join(f.root,'home');await mkdir(home);await writeFile(join(home,'.gitconfig'),`[url "ext::touch ${sentinel}"]\n insteadOf = https://rewrite.invalid/\n`);
  const previous=process.env.HOME;process.env.HOME=home;
  try {await assert.rejects(production.checkRemote('https://rewrite.invalid/repo'));await assert.rejects(access(sentinel));}
  finally {if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});
test('fetch leaves HEAD unchanged; preview fast forwards and preserves binary outside files',async t=>{
  const f=await fixture(t),a=f.service('a');await bind(a);await commit(a,'initial',true);
  const b=f.service('b'),bb=await bind(b);const binary=Buffer.from([0,255,128,10,13]);
  await writeFile(join(bb.repositoryPath,'image.bin'),binary);git(bb.repositoryPath,'add','image.bin');git(bb.repositoryPath,'commit','-m','binary');await b.push();
  const old=(await a.status()).head;await a.fetch();assert.equal((await a.status()).head,old);assert.equal((await a.status()).behind,1);
  const p=await a.previewCommit({files:files('next'),revision:'r',message:'next',push:true});assert.notEqual(p.head,old);
  const ab=(await a.getBinding())!;assert.deepEqual(await readFile(join(ab.repositoryPath,'image.bin')),binary);
  await a.confirmCommit({token:p.token,revision:'r',requestId:'binary'});assert.deepEqual(await readFile(join(ab.repositoryPath,'image.bin')),binary);
});
test('fast forward supports file/directory transitions outside the managed snapshot', async t => {
  const f = await fixture(t), a = f.service('a'), ab = await bind(a); await commit(a, 'initial', true);
  const b = f.service('b'), bb = await bind(b);
  await mkdir(join(bb.repositoryPath, 'docs/nested'), { recursive: true });
  await writeFile(join(bb.repositoryPath, 'docs/nested/old.txt'), 'old');
  git(bb.repositoryPath, 'add', 'docs'); git(bb.repositoryPath, 'commit', '-m', 'directory'); await b.push();
  await commit(a, 'initial', true);
  await rm(join(bb.repositoryPath, 'docs'), { recursive: true });
  await writeFile(join(bb.repositoryPath, 'docs'), 'replacement file');
  git(bb.repositoryPath, 'add', '-A'); git(bb.repositoryPath, 'commit', '-m', 'directory to file'); await b.push();
  await commit(a, 'initial', true);
  assert.equal(await readFile(join(ab.repositoryPath, 'docs'), 'utf8'), 'replacement file');
  await rm(join(bb.repositoryPath, 'docs'));
  await mkdir(join(bb.repositoryPath, 'docs/nested'), { recursive: true });
  await writeFile(join(bb.repositoryPath, 'docs/nested/new.txt'), 'new');
  git(bb.repositoryPath, 'add', '-A'); git(bb.repositoryPath, 'commit', '-m', 'file to directory'); await b.push();
  await commit(a, 'initial', true);
  assert.equal(await readFile(join(ab.repositoryPath, 'docs/nested/new.txt'), 'utf8'), 'new');
  assert.equal((await a.status()).dirty, false);
  assert.equal((await f.service('a').recover()).recovered, 0);
});

test('file/directory transitions recover every partially installed shape and preserve external files', async t => {
  for (const direction of ['directory-to-file', 'file-to-directory']) {
    const before = { 'manifest.json': '{"formatVersion":1}\n', ...(direction === 'directory-to-file' ? { 'item/nested/old.txt': 'old' } : { item: 'old' }) } as Record<string, string>;
    const after = { 'manifest.json': '{"formatVersion":1}\n', ...(direction === 'directory-to-file' ? { item: 'new' } : { 'item/nested/new.txt': 'new' }) } as Record<string, string>;
    const phases = ['ref-updated', 'worktree-file-removed', ...(direction === 'directory-to-file' ? ['worktree-directory-removed'] : []), 'worktree-file-installed'];
    for (const phase of phases) await t.test(`${direction}: ${phase}`, async st => {
      const f = await fixture(st); let armed = false;
      const a = f.service('a', { testCheckpoint: at => { if (armed && at === phase) throw new Error('simulated interruption'); } }), binding = await bind(a);
      const initial = await a.previewCommit({ files: before, revision: 'r', message: 'before' });
      await a.confirmCommit({ token: initial.token, revision: 'r', requestId: 'before' });
      const preview = await a.previewCommit({ files: after, revision: 'r', message: 'after' });
      const request = { token: preview.token, revision: 'r', requestId: 'after' }; armed = true;
      await assert.rejects(a.confirmCommit(request), /simulated interruption/);
      const restarted = f.service('a');
      const external = join(binding.repositoryPath, 'do-not-delete.txt'); await writeFile(external, 'external');
      await assert.rejects(restarted.recover(), { code: 'RECOVERY_REQUIRED' });
      assert.equal(await readFile(external, 'utf8'), 'external'); await rm(external);
      assert.ok((await restarted.recover()).recovered > 0);
      const result = await restarted.confirmCommit(request);
      assert.equal(result.committed, true); assert.deepEqual({ ...await restarted.readSnapshot(result.sha!) }, after);
      assert.equal((await restarted.status()).dirty, false);
      assert.equal((await restarted.recover()).recovered, 0);
      assert.equal((await restarted.history()).commits.length, 2);
    });
  }
});

test('directory replacement refuses an external file added after the ref update', async t => {
  const f = await fixture(t); let inject = false, repositoryPath = '';
  const a = f.service('a', { testCheckpoint: async phase => {
    if (inject && phase === 'ref-updated') await writeFile(join(repositoryPath, 'orchard-config/item/external.txt'), 'keep');
  } });
  repositoryPath = (await bind(a)).repositoryPath;
  const before = await a.previewCommit({ files: { ...files('initial'), 'item/old.txt': 'old' }, revision: 'r', message: 'before' });
  await a.confirmCommit({ token: before.token, revision: 'r', requestId: 'before' });
  const after = await a.previewCommit({ files: { ...files('initial'), item: 'new' }, revision: 'r', message: 'after' }); inject = true;
  await assert.rejects(a.confirmCommit({ token: after.token, revision: 'r', requestId: 'after' }), { code: 'DIRTY_REPOSITORY' });
  assert.deepEqual((await readdir(join(repositoryPath, 'orchard-config/item'))).sort(), ['external.txt', 'old.txt']);
  assert.equal(await readFile(join(repositoryPath, 'orchard-config/item/external.txt'), 'utf8'), 'keep');
});

test('invalid existing directory blocks binding; newer format binds read-only',async t=>{
  const f=await fixture(t),a=f.service('a');await bind(a);await commit(a,'initial',true);
  const ab=(await a.getBinding())!;await writeFile(join(ab.repositoryPath,'orchard-config/manifest.json'),'{broken');git(ab.repositoryPath,'add','.');git(ab.repositoryPath,'commit','-m','invalid');git(ab.repositoryPath,'push',f.remote,'main');
  const b=f.service('b');await assert.rejects(bind(b));assert.equal(await b.getBinding(),null);
  await writeFile(join(ab.repositoryPath,'orchard-config/manifest.json'),'{"formatVersion":3}');git(ab.repositoryPath,'add','.');git(ab.repositoryPath,'commit','-m','future');git(ab.repositoryPath,'push',f.remote,'main');
  const c=f.service('c');assert.equal((await bind(c)).snapshotState,'unsupported');await assert.rejects(commit(c,'overwrite'),{code:'FORMAT_UNSUPPORTED'});
});
test('interrupted ref move recovers raw files and refuses external edits',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a);const first=await commit(a,'first'),second=await commit(a,'second');
  const path=join(b.repositoryPath,'orchard-config/settings.txt');await writeFile(path,'first');git(b.repositoryPath,'read-tree',first.sha!);
  const journal=join(f.root,'a/config-git/operations/move-aaaaaaaa.json');await writeFile(journal,JSON.stringify({bindingId:b.id,phase:'ref-updated',old:first.sha,next:second.sha}));
  await writeFile(path,'external edit');await assert.rejects(a.recover(),{code:'RECOVERY_REQUIRED'});assert.equal(await readFile(path,'utf8'),'external edit');
  await writeFile(path,'first');assert.equal((await a.recover()).recovered,1);assert.equal(await readFile(path,'utf8'),'second');assert.equal((await a.status()).dirty,false);assert.equal((await a.recover()).recovered,0);
});
test('SIGKILL at durable commit boundaries recovers a stable receipt without duplicate commits',async t=>{
  for(const phase of ['accepted','commit-created','ref-updated','worktree-installed','local-committed','pushed']) await t.test(phase,async st=>{
    const f=await fixture(st),a=f.service('a');await bind(a);
    const script=join(f.root,'kill.mjs'),requestFile=join(f.root,'request.json');
    await writeFile(script,`
      import {GitRepositoryService} from ${JSON.stringify(new URL('../src/config-git/repository.ts',import.meta.url).href)};
      import {writeFileSync} from 'node:fs';
      const service=new GitRepositoryService(${JSON.stringify(join(f.root,'a'))},{
        testTransport:()=>${JSON.stringify(f.remote)}, validateSnapshot:()=>{},
        testCheckpoint:phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}
      });
      const preview=await service.previewCommit({files:${JSON.stringify(files('killed'))},revision:'r',message:'one commit',push:true});
      const request={token:preview.token,revision:'r',requestId:'kill-boundary'};
      writeFileSync(${JSON.stringify(requestFile)},JSON.stringify(request));
      await service.confirmCommit(request);
    `);
    assert.throws(()=>execFileSync(process.execPath,['--import','tsx',script],{cwd:process.cwd(),stdio:'pipe'}),(e:unknown)=>(e as {signal:string}).signal==='SIGKILL');
    const restarted=f.service('a');assert.ok((await restarted.recover()).recovered>=1);
    const request=JSON.parse(await readFile(requestFile,'utf8')),result=await restarted.confirmCommit(request);
    assert.equal(result.committed,phase!=='accepted');assert.equal(result.pushed,phase==='pushed');
    assert.equal((await restarted.status()).dirty,false);
    if(phase!=='accepted') {assert.equal((await restarted.history()).commits.length,1);assert.equal((await restarted.readSnapshot(result.sha!))['settings.txt'],'killed');}
    assert.equal((await restarted.recover()).recovered,0);assert.deepEqual(await restarted.confirmCommit(request),result);
  });
});
test('unsafe snapshot paths and repository symlinks are rejected',async t=>{
  const f=await fixture(t),a=f.service('a'),b=await bind(a);
  await assert.rejects(a.previewCommit({files:{'../escape':'x'},revision:'r',message:'bad'}),{code:'INVALID_PATH'});
  const {symlink}=await import('node:fs/promises');await symlink(f.root,join(b.repositoryPath,'escape'));
  await assert.rejects(commit(a,'bad'),{code:'DIRTY_REPOSITORY'});
});
