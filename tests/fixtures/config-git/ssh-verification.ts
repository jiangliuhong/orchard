// Run: node --import tsx tests/fixtures/config-git/ssh-verification.ts
// Requires passwordless sudo for an isolated sshd. Never touches existing SSH configuration.
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { GitRepositoryService } from '../../../src/config-git/repository.js';
const root=await fs.mkdtemp(join(tmpdir(),'orchard-real-ssh-'));
const run=(cmd:string,args:string[],cwd=root)=>execFileSync(cmd,args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const git=(cwd:string,...args:string[])=>run('/usr/bin/git',args,cwd);
const oldPath=process.env.PATH;
const results:string[]=[];
let daemon:ReturnType<typeof spawn>|undefined;
let serverPid:number|undefined;
const evidence=resolve('docs/features/2026-11-06-config-git-storage/ssh-verification.md');
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;
try {
  const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
  const user=run('/usr/bin/id',['-un']);
  run('/usr/bin/ssh-keygen',['-t','ed25519','-N','','-f',join(root,'host')]);
  run('/usr/bin/ssh-keygen',['-t','ed25519','-N','','-f',join(root,'client')]);
  run('/usr/bin/ssh-keygen',['-t','ed25519','-N','','-f',join(root,'wrong-client')]);
  await fs.copyFile(join(root,'client.pub'),join(root,'authorized_keys'));
  const hostPublic=(await fs.readFile(join(root,'host.pub'),'utf8')).trim().split(' ').slice(0,2).join(' ');
  await fs.writeFile(join(root,'known_hosts'),`[127.0.0.1]:${port} ${hostPublic}\n`);
  const clientConfig=join(root,'client-config');
  const config=(identity:string,knownHosts=join(root,'known_hosts'))=>`Host *\n IdentityFile ${identity}\n IdentitiesOnly yes\n UserKnownHostsFile ${knownHosts}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n BatchMode yes\n`;
  await fs.writeFile(clientConfig,config(join(root,'client')));
  const daemonConfig=join(root,'sshd_config'),pidFile=join(root,'sshd.pid');
  await fs.writeFile(daemonConfig,`Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(root,'host')}\nPidFile ${pidFile}\nAuthorizedKeysFile ${join(root,'authorized_keys')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM yes\nStrictModes no\nAllowUsers ${user}\nLogLevel VERBOSE\n`);
  run('/usr/bin/sudo',['-n','/usr/sbin/sshd','-t','-f',daemonConfig]);
  daemon=spawn('/usr/bin/sudo',['-n','/usr/sbin/sshd','-D','-e','-f',daemonConfig],{stdio:['ignore','ignore','pipe']});
  let daemonLog='';daemon.stderr?.on('data',b=>{daemonLog+=String(b);});
  for(let i=0;i<100;i++){try {serverPid=Number(await fs.readFile(pidFile,'utf8'));break;}catch {await new Promise(r=>setTimeout(r,50));}}
  assert.ok(serverPid&&Number.isSafeInteger(serverPid),'isolated sshd startup');
  const bin=join(root,'bin');await fs.mkdir(bin);await fs.writeFile(join(bin,'ssh'),`#!/bin/sh\nexec /usr/bin/ssh -F ${quote(clientConfig)} "$@"\n`,{mode:0o700});process.env.PATH=`${bin}:${oldPath}`;
  const remote=join(root,'remote.git');await fs.mkdir(remote);git(remote,'init','--bare','--initial-branch=main');
  const url=`ssh://${user}@127.0.0.1:${port}${remote}`;
  const files=(value:string)=>({'manifest.json':'{"formatVersion":1}\n','settings.txt':value});
  const service=(name:string)=>new GitRepositoryService(join(root,name),{validateSnapshot:f=>assert.equal(JSON.parse(f['manifest.json']).formatVersion,1),timeoutMs:15000});
  const a=service('a'),b=service('b');
  const bind=(s:GitRepositoryService)=>s.bind({remoteUrl:url,branch:'main',identity:{name:'Orchard SSH Verification',email:'fixture@localhost'}});
  const commit=async(s:GitRepositoryService,value:string,push=true,regenerate=false)=>{const p=await s.previewCommit({files:files(value),revision:'r',message:value,push,regenerate});return s.confirmCommit({token:p.token,revision:'r',requestId:crypto.randomUUID()});};
  assert.equal((await a.checkRemote(url)).branches.length,0);const ab=await bind(a);const first=await commit(a,'initial');assert.equal(first.pushed,true);results.push(`PASS — SSH connection, empty bind, initial commit and push; SHA ${first.sha}.`);
  const bb=await bind(b);assert.equal((await b.readSnapshot(first.sha!))['settings.txt'],'initial');await commit(b,'remote advancement');const old=(await a.status()).head;await a.fetch();assert.equal((await a.status()).head,old);assert.equal((await a.status()).behind,1);await commit(a,'fast forward');results.push('PASS — second SSH clone reads fixed SHA; fetch observes remote advancement without moving HEAD; commit preview fast-forwards and ordinary push succeeds.');
  const dirty=join(ab.repositoryPath,'orchard-config/settings.txt');await fs.writeFile(dirty,'external edit');await assert.rejects(commit(a,'blocked'),{code:'DIRTY_REPOSITORY'});assert.equal(await fs.readFile(dirty,'utf8'),'external edit');await fs.writeFile(dirty,'fast forward');results.push('PASS — dirty worktree blocks commit and preserves external contents.');
  await commit(b,'device B',true);await commit(a,'device A',false);await a.fetch();assert.equal((await a.status()).diverged,true);await assert.rejects(a.push(),{code:'REMOTE_DIVERGED'});const regenerated=await commit(a,'regenerated',true,true);assert.equal(regenerated.pushed,true);assert.ok(regenerated.backupRef);results.push(`PASS — two-device divergence rejects push; explicit regeneration retains backup ${regenerated.backupRef} and pushes SHA ${regenerated.sha}.`);
  await fs.mkdir(join(remote,'hooks'),{recursive:true});const rejectionHook=join(remote,'hooks/pre-receive');await fs.writeFile(rejectionHook,'#!/bin/sh\necho "isolated fixture rejects updates" >&2\nexit 1\n',{mode:0o700});const rejected=await commit(a,'server rejection');assert.equal(rejected.committed,true);assert.equal(rejected.pushed,false);assert.equal(rejected.pushError,'PUSH_REJECTED');assert.equal((await a.status()).head,rejected.sha);await fs.unlink(rejectionHook);await a.push();results.push(`PASS — owned local SSH server pre-receive hook rejects push; local SHA ${rejected.sha} retained and subsequent ordinary push succeeds. This simulates server rejection, not hosted branch protection.`);
  await fs.writeFile(clientConfig,config(join(root,'wrong-client')));await assert.rejects(a.checkRemote(url),{code:'AUTH_FAILED'});await fs.writeFile(clientConfig,config(join(root,'client'),'/dev/null'));await assert.rejects(a.checkRemote(url),{code:'AUTH_FAILED'});await fs.writeFile(clientConfig,config(join(root,'client')));results.push('PASS — wrong client key and unknown host key fail with AUTH_FAILED; no host key auto-acceptance.');
  await b.fetch();await commit(b,'sync future',true,true);await fs.writeFile(join(bb.repositoryPath,'orchard-config/manifest.json'),'{"formatVersion":2}\n');git(bb.repositoryPath,'add','orchard-config/manifest.json');git(bb.repositoryPath,'commit','-m','future format');await b.push();const future=service('future');assert.equal((await bind(future)).snapshotState,'unsupported');await assert.rejects(commit(future,'overwrite'),{code:'FORMAT_UNSUPPORTED'});results.push('PASS — newer snapshot format binds as unsupported and cannot be overwritten.');
  results.push(`PASS — SSH daemon accepted public-key authentication (${(daemonLog.match(/Accepted publickey/g)||[]).length} observed authentication log entries).`);
  const report=`# Isolated production SSH verification\n\nExecuted ${new Date().toISOString()}.\n\nEnvironment: ${process.version}; ${run('/usr/bin/git',['--version'])}; ${run('/usr/bin/uname',['-sr'])}.\n\nCommand: \`node --import tsx tests/fixtures/config-git/ssh-verification.ts\`.\n\nThe script generated temporary Ed25519 host/client keys, pinned the generated host public key in a temporary known_hosts, and launched \`sudo -n /usr/sbin/sshd -D -e -f <temporary-config>\` on loopback port ${port}. It supplied a temporary PATH wrapper invoking \`/usr/bin/ssh -F <temporary-client-config> "$@"\`. GitRepositoryService used validated \`ssh://${user}@127.0.0.1:${port}/<temporary-bare-repository>\` URLs through its production transport, with no testTransport injection. No existing remote or production SSH configuration was changed.\n\n${results.map(r=>'- '+r).join('\n')}\n\nFinding and fix: the first server-rejection run exposed push porcelain rejection text on stdout, previously classified as REMOTE_UNKNOWN because only stderr was inspected. The Git runner now classifies push errors using both bounded streams while never returning raw transport text. This complete run passed after the fix. The fixture uses UsePAM yes for the host account check while disabling password and keyboard-interactive authentication; UsePAM no rejected this environment's locked-password ubuntu account before public-key authentication.\n\nCleanup: the exact sshd PID from its private pidfile is terminated in finally; all fixture repositories and keys are removed. No private key contents are recorded.\n\nLimitations: this is a real local OpenSSH/Git transport verification, not a hosted GitHub/GitLab service test. Hosted SSH policy, HTTPS authentication, hosted protected branches, mid-network push interruption, and browser/Bridge end-to-end verification are not established by this run. Process-kill receipt recovery is covered separately by config-git-repository.test.ts.\n`;
  await fs.mkdir(join(evidence,'..'),{recursive:true});await fs.writeFile(evidence,report);console.log(results.join('\n'));console.log(`Evidence: ${evidence}`);
} finally {
  process.env.PATH=oldPath;
  if(serverPid) {try {run('/usr/bin/sudo',['-n','/bin/kill','-TERM',String(serverPid)]);}catch {}}
  if(daemon&&daemon.exitCode===null) await Promise.race([new Promise<void>(r=>daemon!.once('close',()=>r())),new Promise<void>(r=>setTimeout(r,2000))]);
  await fs.rm(root,{recursive:true,force:true});
}
