#!/usr/bin/env node
// Real Chromium + compiled Orchard, no mocked fetches or project dependencies.
// Run only after production build approval: node tests/fixtures/config-git/browser-verification.mjs --production-build-ready
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { setupBrowserSSH, browserGitWorkflow } from './browser-ssh-workflow.mjs';

if (!process.argv.includes('--production-build-ready')) throw new Error('Wait for parent production-build-ready notification before running.');
const root = resolve(import.meta.dirname, '../../..');
const releaseDigest = JSON.parse(await readFile(join(root, 'dist/migration-integrity.json'), 'utf8')).releaseDigest;
const feature = join(root, 'docs/features/2026-11-06-config-git-storage');
const shots = join(feature, 'screenshots');
const scratch = await mkdtemp(join(tmpdir(), 'orchard-browser-verification-'));
const chromePath = process.env.ORCHARD_TEST_CHROMIUM ?? '/home/ubuntu/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';
const children = [], clients = [], checks = [], events = [], network = [];
const withSSH = process.argv.includes('--with-ssh');
let serverLog = '', failure, ssh;
await mkdir(shots, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(work, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await work(); if (value) return value; } catch (e) { error = e; }
    await delay(150);
  }
  throw new Error(`Timed out: ${label}${error ? ` (${error.message})` : ''}`);
}
async function freePort() {
  const listener = createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
class CDP {
  constructor(socket, name) {
    this.socket = socket; this.name = name; this.sequence = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else if (message.method === 'Network.requestWillBeSent') {
        network.push({ browser: name, event: 'request', id: message.params.requestId, url: message.params.request.url, type: message.params.type, at: Date.now() });
      } else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Network.loadingFailed' || message.method === 'Log.entryAdded' && message.params.entry.level === 'error' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        events.push({ browser: name, method: message.method, at: Date.now(), params: message.params });
      } else if (message.method === 'Network.responseReceived') {
        network.push({ browser: name, event: 'response', id: message.params.requestId, url: message.params.response.url, status: message.params.response.status, at: Date.now() });
        if (message.params.response.status >= 400) events.push({ browser: name, method: message.method, url: message.params.response.url, status: message.params.response.status });
      }
    });
  }
  send(method, params = {}) {
    if (method === 'Page.navigate' || method === 'Page.reload') network.push({ browser: this.name, event: 'intentional-navigation', method, at: Date.now(), url: params.url });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 45000);
      this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async text() { return this.evaluate('document.body.innerText'); }
  async click(text) {
    const point = await this.evaluate(`(() => {const node=[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)}); if(!node||node.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(shots, `${name}.png`), Buffer.from(data, 'base64'));
  }
  async request(path, body) {
    return this.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(path)},${JSON.stringify(body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })});return {status:r.status,body:await r.json()};})()`);
  }
  async preference() { return this.evaluate(`JSON.parse(localStorage.getItem('orchard-browser-preference'))`); }
  async theme(value) {
    await this.evaluate(`(()=>{const node=document.querySelector('select[aria-label="外观"]'); if(!node)throw new Error('No global theme picker'); node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(async () => (await this.preference()).theme === value, `theme ${value}`);
  }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('CDP closed')); } this.pending.clear(); this.socket.close(); }
}
async function browser(name, url) {
  const profile = join(scratch, name); await mkdir(profile);
  const child = spawn(chromePath, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  children.push(child);
  const port = await waitFor(async () => Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]), `${name} debug port`);
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const client = new CDP(socket, name); clients.push(client);
  await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map(method => client.send(method)));
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  const document = await fetch(url, { signal: AbortSignal.timeout(10000) });
  console.log(`${name} document HTTP ${document.status}, bytes ${(await document.text()).length}`);
  await client.send('Page.bringToFront');
  void client.send('Page.navigate', { url }).catch(error => network.push({ browser: name, event: 'navigation-command', message: error.message }));
  try { await waitFor(async () => (await client.text()).includes('Git 配置存储'), `${name} settings`, 40000); }
  catch {
    network.push({ browser: name, event: 'initial-navigation-stalled', diagnostic: await client.evaluate('JSON.stringify({href:location.href,text:document.body?.innerText,ready:document.readyState})') });
    console.log(`${name}: initial navigation stalled; retrying one reload`);
    void client.send('Page.reload', { ignoreCache: true }).catch(error => network.push({ browser: name, event: 'reload-command', message: error.message }));
    await waitFor(async () => (await client.text()).includes('Git 配置存储'), `${name} settings after reload`, 30000);
  }
  return client;
}
function passed(name, evidence) { checks.push({ name, result: 'passed', evidence }); console.log(`PASS ${name}`); }
try {
  if (withSSH) ssh = await setupBrowserSSH(scratch, freePort, waitFor);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/server/main.js', '--data-dir', join(scratch, 'data'), '--port', String(port)], { cwd: root, env: ssh?.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server); server.stdout.on('data', c => { serverLog += c; }); server.stderr.on('data', c => { serverLog += c; });
  await waitFor(async () => (await (await fetch(`${origin}/api/health`)).json()).ready, 'isolated server ready', 55000);
  const a = await browser('profile-a', `${origin}/settings`);
  await a.click('Git 配置存储');
  await waitFor(async () => (await a.text()).includes('绑定远端仓库'), 'unbound form');
  assert.equal((await a.request('/api/config-git/repository')).body.binding, null);
  await a.screenshot('01-unbound'); passed('Unbound Git settings render against real production server', { origin, dataDir: join(scratch, 'data') });

  await a.evaluate(`(()=>{const node=document.querySelector('input[placeholder^="git@github.com"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'file:///tmp/orchard-browser-test-invalid');node.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await a.click('检测连接');
  await waitFor(async () => /INVALID_REMOTE|CONFIG_OPERATION_FAILED/.test(await a.text()), 'remote check error');
  await a.screenshot('02-connection-error'); passed('Unsafe local remote rejected through real async connection check', { remote: 'file:///tmp/orchard-browser-test-invalid', noNetworkContact: true });

  const initial = await a.preference();
  await a.theme('dark'); await a.screenshot('03-dark');
  assert.equal(await a.evaluate('document.documentElement.classList.contains("dark")'), true);
  await a.theme('system'); const changed = await a.preference();
  assert.equal(changed.preferenceRevision, initial.preferenceRevision + 2);
  await a.send('Page.reload');
  await waitFor(async () => (await a.text()).includes('Git 配置存储'), 'reload settings');
  assert.equal((await a.preference()).clientId, initial.clientId);
  assert.equal((await a.preference()).preferenceRevision, changed.preferenceRevision);
  await a.screenshot('04-system-reloaded'); passed('Dark → system persists identity and increments revision twice across reload', changed);

  const b = await browser('profile-b', `${origin}/settings`), bInitial = await b.preference();
  assert.notEqual(bInitial.clientId, initial.clientId);
  const exported = await a.request('/api/config-git/export', { theme: 'light' });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  await a.click('Git 配置存储');
  const beforeClaim = await a.preference();
  const claimResponse = await a.request('/api/config-git/general/claim', { clientId: initial.clientId, preferenceRevision: beforeClaim.preferenceRevision, requestId: crypto.randomUUID() });
  assert.equal(claimResponse.status, 200, JSON.stringify(claimResponse.body));
  const item = claimResponse.body; assert.equal(item.requiresConfirmation, true);
  assert.equal((await a.preference()).theme, 'system');
  // Change the actual global picker after API acceptance, before the pending poll.
  await a.theme('dark'); const preApply = await a.preference();
  await waitFor(async () => (await a.text()).includes('确认恢复浏览器外观'), 'claim confirmation');
  const wrong = await b.request(`/api/config-git/general/pending?clientId=${bInitial.clientId}`);
  assert.deepEqual(wrong.body.items, []);
  assert.equal((await b.preference()).theme, bInitial.theme);
  await a.screenshot('05-explicit-claim-conflict'); await b.screenshot('06-isolated-browser');
  await a.click('应用恢复外观');
  await waitFor(async () => !(await a.text()).includes('确认恢复浏览器外观') && (await a.preference()).theme === 'light', 'explicit claim apply');
  const applied = await a.preference();
  assert.deepEqual(applied.consumed[item.operationId], { decision: 'apply', revision: preApply.preferenceRevision, force: true });
  assert.equal((await a.request(`/api/config-git/general/pending?clientId=${initial.clientId}`)).body.items.length, 0);
  await a.screenshot('07-claim-applied');
  passed('Explicit claim conflict applies with pre-apply revision/force and does not affect profile B', { operationId: item.operationId, receipt: applied.consumed[item.operationId], aClientId: initial.clientId, bClientId: bInitial.clientId });

  await a.send('Page.reload');
  await waitFor(async () => (await a.text()).includes('Git 配置存储'), 'reload after acknowledgement');
  assert.equal((await a.preference()).preferenceRevision, applied.preferenceRevision);
  assert.equal((await a.preference()).theme, 'light');
  passed('Acknowledged preference survives reload without a second apply', { revision: applied.preferenceRevision });

  await a.click('Git 配置存储'); await a.theme('dark'); await a.click('领取服务端外观快照');
  await waitFor(async () => (await a.text()).includes('确认恢复浏览器外观'), 'second claim');
  await a.click('保留当前外观');
  await waitFor(async () => !(await a.text()).includes('确认恢复浏览器外观'), 'keep current theme');
  assert.equal((await a.preference()).theme, 'dark');
  await a.screenshot('08-keep-current'); passed('Explicit keep choice retains current dark appearance', {});
  if (ssh) await browserGitWorkflow({ a, b, ssh, waitFor, passed });
  const exceptions = events.filter(event => event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions));
  const canceledByNavigation = events.filter(event => event.method === 'Network.loadingFailed').flatMap(event => {
    const navigation = network.findLast(n => n.browser === event.browser && n.event === 'intentional-navigation' && n.at <= event.at && event.at - n.at <= 3000);
    const request = network.find(n => n.browser === event.browser && n.event === 'request' && n.id === event.params.requestId);
    return event.params.canceled && event.params.errorText === 'net::ERR_ABORTED' && navigation && request
      ? [{ event, url: request.url, navigation: navigation.method, navigationAt: navigation.at, canceledAt: event.at, delayMs: event.at - navigation.at }] : [];
  });
  const unexpectedNetwork = events.filter(event => event.method === 'Network.responseReceived' || event.method === 'Network.loadingFailed' && !canceledByNavigation.some(item => item.event === event));
  assert.equal(unexpectedNetwork.length, 0, JSON.stringify(unexpectedNetwork));
  passed('No JavaScript exceptions, console.error or unexpected failed network requests', { monitoredEvents: events, intentionalNavigationCancellations: canceledByNavigation, navigationRetries: network.filter(n => n.event === 'initial-navigation-stalled') });
} catch (error) {
  failure = error;
  console.error(error);
  for (const client of clients) { try { await client.screenshot(`failure-${client.name}`); } catch {} }
} finally {
  for (const client of clients) client.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
  await delay(300);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (ssh) await ssh.cleanup();
  const releaseDigestAtEnd = JSON.parse(await readFile(join(root, 'dist/migration-integrity.json'), 'utf8')).releaseDigest;
  const evidence = { executedAt: new Date().toISOString(), releaseDigest, releaseDigestAtEnd, withSSH, node: process.version, chrome: execFileSync(chromePath, ['--version'], { encoding: 'utf8' }).trim(), git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), note: 'Working tree includes uncommitted implementation; build generated by parent.', scratch, checks, events, network, failure: failure?.stack };
  await writeFile(join(shots, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
  await writeFile(join(scratch, 'server.log'), serverLog);
  const gitResult = checks.find(check => check.name.startsWith('UI local/remote history'))?.evidence;
  const gitSummary = gitResult ? [`实际初次提交/恢复来源 SHA：\`${gitResult.firstSha}\`。第二次提交/恢复后保留 HEAD：\`${gitResult.secondSha}\`。`, '', `恢复 API 操作 ID：\`${gitResult.apiOperationId}\`；持久化恢复 ID：\`${gitResult.restoreOperationId}\`。自动应用回执：\`${JSON.stringify(gitResult.receipt)}\`。观察到 ${gitResult.sshAuthentications} 次公钥认证。`, ''] : [];
  const lines = [`# Git 配置存储：真实浏览器验证`, '', `执行时间：${evidence.executedAt}`, '', `结果：${failure ? '存在失败，未完成验收' : '本报告范围内全部通过'}。使用真实 Chromium ${evidence.chrome}、生产编译服务、独立临时 data-dir 和两个独立浏览器 profile。浏览器请求均为同源真实 API 请求，无 fetch mock。${withSSH ? 'Git 远端为临时 loopback sshd 与 bare repository，使用生产 SSH 传输。' : '本次未连接 Git 远端。'}`, '', `- 构建 release digest：${releaseDigest}`, `- Node：${evidence.node}`, `- Git：${evidence.git}`, `- 代码基线：${evidence.commit}（含未提交实现）`, `- 隔离资料及服务日志：\`${scratch}\``, '', '复现命令（必须先完成生产构建）：', '', '```sh', `node tests/fixtures/config-git/browser-verification.mjs --production-build-ready${withSSH ? ' --with-ssh' : ''}`, '```', '', '| 验证项 | 实际结果 |', '| --- | --- |', ...checks.map(check => `| ${check.name} | 通过 |`), ...(failure ? [`| 执行失败 | ${failure.message.replaceAll('|', '/')} |`] : []), '', ...gitSummary, '首轮调试曾遇到 Chromium 初次导航停滞；脚本会等待实际 DOM 并最多重载一次。若重载取消了尚未完成的资源请求，保留 net::ERR_ABORTED 记录，不将主动取消记为应用异常。最新执行的重试次数与完整请求时间线保存在 evidence。', '', '完整操作 ID、客户端 ID、回执、浏览器异常与网络事件见 [browser-evidence.json](screenshots/browser-evidence.json)。', '', '截图：', '', ...['01-unbound', '02-connection-error', '03-dark', '04-system-reloaded', '05-explicit-claim-conflict', '06-isolated-browser', '07-claim-applied', '08-keep-current', ...(withSSH ? ['09-ssh-connection', '10-ssh-bound', '11-commit-preview', '12-commit-pushed', '13-explicit-push', '14-local-history', '15-restore-preview', '16-sha-restored'] : [])].map(name => `- [${name}](screenshots/${name}.png)`), '', '## 验证边界', '', '未连接托管 Git 服务；连接错误用禁止的 file 协议触发真实服务校验，未验证托管 SSH 策略、HTTPS 认证、真实托管远端 clone/fetch/push、受保护分支、分叉、推送中断或跨设备 Git 往返。未安装真实浏览器扩展，未验证 Web Bridge 重握手。这里的浏览器隔离测试使用同一服务上的两个独立 profile，不能替代两台设备的完整恢复。', '', withSSH ? '偏好领取部分通过真实 export/claim/pending/ack API 验证；Git 工作流使用页面操作完成真实连接、绑定、预览、提交推送、本地提交、独立推送、本地/远端历史及固定 SHA 常规类别恢复。临时 host/client keys、known_hosts、SSH 配置和 bare repository 在 finally 删除，精确终止私有 pidfile 中的 sshd PID。未在本脚本进行数据库崩溃恢复、多类别恢复、依赖扩展或本机映射测试。' : '偏好快照通过真实 export API 写入隔离服务，然后通过 claim/pending/ack 协议验证；不是完整 Git SHA 恢复。未在本脚本进行数据库崩溃恢复测试。', '', '系统外观在 headless Linux 中以 Chromium 默认系统配置解析；验证的是 system 偏好的选择、revision 与持久化，并未模拟操作系统实时切换。', ''];
  await writeFile(join(feature, 'browser-verification.md'), lines.join('\n'));
}
if (failure) process.exitCode = 1;
