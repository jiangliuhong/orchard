import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Temporary production SSH transport: no Git testTransport or API mocks.
export async function setupBrowserSSH(scratch, freePort, waitFor) {
  const dir = join(scratch, 'ssh'); await mkdir(dir);
  const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args) => run('/usr/bin/git', ['--git-dir', join(dir, 'remote.git'), ...args]);
  const user = run('/usr/bin/id', ['-un']), port = await freePort();
  let daemon, pid;
  const cleanup = async () => {
    if (pid) { try { run('/usr/bin/sudo', ['-n', '/bin/kill', '-TERM', String(pid)]); } catch {} }
    if (daemon && daemon.exitCode === null) await Promise.race([new Promise(resolve => daemon.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (const name of ['host', 'client']) run('/usr/bin/ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', join(dir, name)]);
    await copyFile(join(dir, 'client.pub'), join(dir, 'authorized_keys'));
    const host = (await readFile(join(dir, 'host.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ');
    await writeFile(join(dir, 'known_hosts'), `[127.0.0.1]:${port} ${host}\n`);
    const config = join(dir, 'client-config');
    await writeFile(config, `Host *\n IdentityFile ${join(dir, 'client')}\n IdentitiesOnly yes\n UserKnownHostsFile ${join(dir, 'known_hosts')}\n GlobalKnownHostsFile /dev/null\n StrictHostKeyChecking yes\n BatchMode yes\n`);
    const daemonConfig = join(dir, 'sshd_config');
    await writeFile(daemonConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(dir, 'host')}\nPidFile ${join(dir, 'sshd.pid')}\nAuthorizedKeysFile ${join(dir, 'authorized_keys')}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM yes\nStrictModes no\nAllowUsers ${user}\nLogLevel VERBOSE\n`);
    run('/usr/bin/sudo', ['-n', '/usr/sbin/sshd', '-t', '-f', daemonConfig]);
    let log = '';
    daemon = spawn('/usr/bin/sudo', ['-n', '/usr/sbin/sshd', '-D', '-e', '-f', daemonConfig], { stdio: ['ignore', 'ignore', 'pipe'] });
    daemon.stderr.on('data', chunk => { log += String(chunk); });
    pid = await waitFor(async () => Number(await readFile(join(dir, 'sshd.pid'), 'utf8')), 'isolated sshd PID');
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const bin = join(dir, 'bin'); await mkdir(bin);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(join(bin, 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(config)} "$@"\n`, { mode: 0o700 });
    run('/usr/bin/git', ['init', '--bare', '--initial-branch=main', join(dir, 'remote.git')]);
    return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, url: `ssh://${user}@127.0.0.1:${port}${join(dir, 'remote.git')}`, git, cleanup, authentications: () => (log.match(/Accepted publickey/g) ?? []).length };
  } catch (error) { await cleanup(); throw error; }
}

export async function browserGitWorkflow({ a, b, ssh, waitFor, passed }) {
  const setField = async (label, value) => a.evaluate(`(() => { const label=[...document.querySelectorAll('label')].find(n=>n.textContent.trim()===${JSON.stringify(label)});const node=label?.querySelector('input');if(!node)throw new Error('Missing input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const operationId = async () => (await a.text()).match(/操作 ([a-f0-9-]{36}) ·/)?.[1];
  const operations = [];
  const operate = async label => {
    const previous = await operationId();
    await a.click(label);
    const id = await waitFor(async () => { const id = await operationId(); return id && id !== previous && id; }, `${label} accepted`);
    const operation = await waitFor(async () => {
      const response = await a.request(`/api/config-git/operations/${id}`);
      assert.equal(response.status, 200);
      if (['failed', 'recovery_required'].includes(response.body.phase)) throw new Error(JSON.stringify(response.body));
      return response.body.phase === 'completed' && response.body;
    }, `${label} completed`, 30000);
    await waitFor(async () => !(await a.evaluate(`document.querySelector('section[aria-label="Git 配置存储"]')?.getAttribute('aria-busy')==='true'`)), `${label} UI unlocked`);
    operations.push({ label, operationId: id, phase: operation.phase, sha: operation.result?.sha, sourceSha: operation.result?.sourceSha });
    return operation;
  };
  const confirmDiff = async button => {
    await waitFor(async () => (await a.text()).includes('确认差异'), 'diff preview');
    while ((await a.text()).includes('加载剩余差异（全部加载后可确认）')) await a.click('加载剩余差异（全部加载后可确认）');
    assert.equal(await a.evaluate(`([...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(button)})).disabled`), true);
    await a.evaluate(`(() => { const label=[...document.querySelectorAll('label')].find(n=>n.textContent.includes('我已查看完整差异'));label.querySelector('input').click(); })()`);
  };

  await setField('仓库地址', ssh.url);
  await operate('检测连接');
  await waitFor(async () => (await a.text()).includes('提交姓名'), 'remote check fields');
  await setField('分支', 'main'); await setField('提交姓名', 'Orchard Browser SSH'); await setField('提交邮箱', 'browser-fixture@localhost');
  await a.screenshot('09-ssh-connection');
  await operate('创建副本并绑定');
  await waitFor(async () => (await a.text()).includes('仓库尚无配置快照'), 'bound empty repository');
  const binding = (await a.request('/api/config-git/repository')).body.binding;
  assert.equal(binding.remoteUrl, ssh.url);
  await a.screenshot('10-ssh-bound');
  passed('Real SSH connection check and empty repository binding through UI', { remote: ssh.url, branch: binding.branch, operations: [...operations] });

  await a.theme('dark'); await a.click('提交并推送'); await setField('提交说明', 'Browser SSH initial dark snapshot');
  await operate('生成提交预览');
  await confirmDiff('确认提交并推送'); await a.screenshot('11-commit-preview');
  const initial = await operate('确认提交并推送');
  assert.equal(initial.result.committed, true); assert.equal(initial.result.pushed, true);
  const firstSha = initial.result.sha; assert.match(firstSha, /^[a-f0-9]{40}$/);
  assert.equal(ssh.git('rev-parse', 'refs/heads/main'), firstSha);
  await a.screenshot('12-commit-pushed');
  passed('UI commit preview requires confirmation; production SSH commit and push writes actual remote SHA', { sha: firstSha, operationId: initial.operationId, result: initial.result });

  await a.theme('light'); await a.click('仅本地提交'); await setField('提交说明', 'Browser SSH second light snapshot');
  await operate('生成提交预览'); await confirmDiff('确认本地提交');
  const second = await operate('确认本地提交');
  const secondSha = second.result.sha; assert.notEqual(secondSha, firstSha); assert.match(secondSha, /^[a-f0-9]{40}$/);
  assert.equal(ssh.git('rev-parse', 'refs/heads/main'), firstSha);
  const push = await operate('推送');
  assert.equal(ssh.git('rev-parse', 'refs/heads/main'), secondSha);
  await a.screenshot('13-explicit-push');
  passed('Local-only UI commit leaves remote unchanged; explicit UI push advances remote', { firstSha, secondSha, commitOperationId: second.operationId, pushOperationId: push.operationId });

  await a.click('本地历史');
  await waitFor(async () => (await a.text()).includes('Browser SSH initial dark snapshot') && (await a.text()).includes('Browser SSH second light snapshot'), 'local history');
  await a.screenshot('14-local-history');
  await operate('从远端恢复');
  await waitFor(async () => (await a.text()).includes('远端配置历史'), 'remote history after fetch');
  // Select the historical fixed SHA from the rendered history row.
  const point = await a.evaluate(`(() => {const row=[...document.querySelectorAll('div.py-3')].find(n=>n.textContent.includes(${JSON.stringify(firstSha)}));const button=row?.querySelector('button');if(!button)throw new Error('History SHA missing');button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await a.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await a.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  await a.evaluate(`(() => { for(const label of document.querySelectorAll('label')){const input=label.querySelector('input[type="checkbox"]');if(input&&['Provider','Web Bridge','工作流','脚本'].includes(label.textContent.trim())&&input.checked)input.click();} })()`);
  await operate('生成恢复预览');
  await confirmDiff('确认应用恢复');
  await a.screenshot('15-restore-preview');
  const bBefore = await b.preference();
  const restored = await operate('确认应用恢复');
  await waitFor(async () => (await a.preference()).theme === 'dark', 'restored theme delivery', 15000);
  const after = await a.preference();
  // Restore receipt uses the durable restore ID, nested in the async API operation result.
  const restoreId = restored.result.operationId;
  assert.ok(restoreId);
  assert.equal(after.consumed[restoreId]?.decision, 'apply');
  assert.equal(after.consumed[restoreId]?.force, false);
  assert.deepEqual(await b.preference(), bBefore);
  assert.equal(ssh.git('rev-parse', 'refs/heads/main'), secondSha);
  const status = (await a.request('/api/config-git/status')).body;
  assert.equal(status.head, secondSha);
  const points = (await a.request('/api/config-git/recovery-points')).body;
  assert.ok((Array.isArray(points) ? points : points.items).length > 0);
  await a.screenshot('16-sha-restored');
  passed('UI local/remote history selects fixed SHA, restores general theme with recovery point and isolated delivery, without moving Git HEAD', { firstSha, secondSha, apiOperationId: restored.operationId, restoreOperationId: restoreId, receipt: after.consumed[restoreId], recoveryPoints: points, operations, sshAuthentications: ssh.authentications() });
}
