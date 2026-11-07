// Run after a production build: node --import tsx tests/fixtures/config-git/runtime-verification.ts
// Uses only compiled production modules, real HTTP and real Node subprocesses.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const dist = resolve('dist');
const compiled = (path: string) => import(pathToFileURL(join(dist, path)).href);
const [{ createApp }, { Bootstrap }, { Store }, { ConfigRestoreService }, { serializeSnapshot, parseSnapshot }] = await Promise.all([
  compiled('server/app.js'), compiled('server/bootstrap.js'), compiled('persistence/store.js'),
  compiled('config-git/restore.js'), compiled('config-git/snapshot.js'),
]);
const release = JSON.parse(await readFile(join(dist, 'migration-integrity.json'), 'utf8')).releaseDigest;
const root = await mkdtemp(join(tmpdir(), 'orchard-restored-runtime-'));
const marker = join(root, 'executed.jsonl');
const routes: string[] = [];
let bootstrap: any, services: any, store: any;
let evidence: Record<string, unknown> | undefined;
const exists = async (path: string) => { try { await access(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; } };
try {
  bootstrap = new Bootstrap(root, 0);
  await bootstrap.start(async () => { store = new Store(root, bootstrap.lease); });
  assert.equal(bootstrap.ready, true, JSON.stringify(bootstrap.status(true)));
  services = createApp(store);
  await services.app.ready();
  const base = await services.app.listen({ host: '127.0.0.1', port: 0 });
  const call = async (method: string, path: string, payload?: unknown) => {
    routes.push(`${method} ${path}`);
    const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(10000),
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) });
    const body = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
    return body as any;
  };
  const source = (kind: string, body: string) => `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(marker)}, JSON.stringify({kind:${JSON.stringify(kind)},pid:process.pid})+'\\n');\n${body}\n`;
  const definition = { id: 'restored-add', name: 'Restored harmless addition', description: '', runtime: 'nodejs',
    entryFile: 'main.ts', inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'number' }, b: { type: 'number' } } },
    outputSchema: { type: 'object', required: ['sum', 'pid'], properties: { sum: { type: 'number' }, pid: { type: 'integer' } } },
    timeoutMs: 10000, resultMode: 'json', files: { 'main.ts': source('script', 'export default input => ({sum:input.a+input.b,pid:process.pid});') } };
  const workflow = { formatVersion: 1, id: 'restored-workflow', name: 'Restored fixed script dependency', inputSchema: definition.inputSchema,
    outputSchema: { type: 'object' }, entryNodeId: 'add', nodes: [
      { id: 'add', name: 'Restored script version', type: 'script', input: { source: 'workflow' }, outputSchema: definition.outputSchema,
        config: { scriptId: definition.id, scriptVersionId: 'restored-script-v1' } },
      { id: 'double', name: 'Restored inline source', type: 'code.nodejs', input: { source: 'node', nodeId: 'add' }, outputSchema: { type: 'object' }, config: { script: 'scripts/double.ts' } },
    ], edges: [{ id: 'add-double', from: 'add', to: 'double' }], result: { source: 'node', nodeId: 'double' } };
  const snapshot = { general: { theme: 'system' }, providers: [], webBridge: { applications: {}, environments: {}, tools: {}, enabledTools: {} },
    scripts: [{ id: definition.id, name: definition.name, description: '', runtime: 'nodejs', archived: false, currentPublishedVersionId: 'restored-script-v1', draft: null, versions: [{ id: 'restored-script-v1', definition }] }],
    workflows: [{ id: workflow.id, name: workflow.name, currentPublishedVersionId: 'restored-workflow-v1', draft: null, versions: [{ id: 'restored-workflow-v1', files: {
      'workflow.json': JSON.stringify(workflow), 'layout.json': JSON.stringify({ add: { x: 0, y: 0 }, double: { x: 240, y: 0 } }),
      'scripts/double.ts': source('workflow', 'export default input => ({sum:input.sum,doubled:input.sum*2,scriptPid:input.pid,workflowPid:process.pid});'),
    } }] }],
  };
  const bundle = serializeSnapshot(snapshot);
  const restore = new ConfigRestoreService(store);
  const preview = await restore.preview(parseSnapshot(bundle.files));
  const restored = await restore.apply(randomUUID(), preview.token);
  assert.equal(restored.phase, 'completed');
  await new Promise<void>(done => setTimeout(done, 100));
  assert.equal(await exists(marker), false, 'restore must not import or execute either source');
  assert.equal(store.all('SELECT id FROM runs').length, 0);
  assert.equal(store.all('SELECT id FROM script_tests').length, 0);
  assert.equal(store.scriptVersion('restored-script-v1').scriptId, definition.id);
  assert.equal(store.version('restored-workflow-v1').workflowId, workflow.id);
  const wait = async (path: string) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const value = await call('GET', path);
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status)) {
        assert.equal(value.status, 'succeeded', JSON.stringify(value)); return value;
      }
      await new Promise<void>(done => setTimeout(done, 30));
    }
    throw new Error(`Runtime timeout: ${path}`);
  };
  const test = await call('POST', '/api/scripts/restored-add/tests', { scriptVersionId: 'restored-script-v1', input: { a: 19, b: 23 }, requestId: randomUUID() });
  const script = await wait(`/api/scripts/restored-add/tests/${test.id}`);
  assert.equal(script.output.sum, 42);
  assert.ok(Number.isInteger(script.output.pid) && script.output.pid > 0 && script.output.pid !== process.pid);
  assert.equal(script.exitCode, 0);
  const run = await call('POST', '/api/workflows/restored-workflow/runs', { versionId: 'restored-workflow-v1', input: { a: 19, b: 23 }, requestId: randomUUID() });
  const result = await wait(`/api/runs/${run.id}`);
  assert.equal(result.output.sum, 42); assert.equal(result.output.doubled, 84);
  assert.equal(result.nodes.length, 2);
  assert.ok(result.nodes.every((node: any) => node.status === 'succeeded'));
  assert.ok(result.output.scriptPid !== process.pid && result.output.workflowPid !== process.pid);
  const executions = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(executions.map(item => item.kind), ['script', 'script', 'workflow']);
  assert.deepEqual(executions.map(item => item.pid), [script.output.pid, result.output.scriptPid, result.output.workflowPid]);
  assert.equal(new Set(executions.map(item => item.pid)).size, 3);
  evidence = { time: new Date().toISOString(), release, node: process.version, transport: base, snapshotDigest: bundle.digest,
    restorePhase: restored.phase, beforeExecution: { markerExists: false, runs: 0, scriptTests: 0 },
    script: { id: test.id, status: script.status, output: script.output, exitCode: script.exitCode },
    workflow: { id: run.id, status: result.status, output: result.output, nodes: result.nodes.map((node: any) => ({ id: node.nodeId, status: node.status })) },
    executions, routes: [...new Set(routes)] };
} finally {
  try { if (services) await services.app.close(); else store?.close(); }
  finally { bootstrap?.release(); await rm(root, { recursive: true, force: true }); }
}
assert.equal(await exists(root), false);
assert.ok(evidence);
evidence.cleanup = 'app closed; directory lease released; temporary data directory and execution markers removed';
const report = `# 配置恢复后的真实运行验收\n\n本验收使用已构建的 dist 生产模块、真实回环 HTTP 监听、生产恢复服务和真实 Node.js 子进程。未使用 mocks、测试 Provider、远端仓库或模型请求；未修改 src。\n\n复现命令（先准备生产 build，本脚本不会重新构建）：\n\n\`\`\`sh\nnode --import tsx tests/fixtures/config-git/runtime-verification.ts\n\`\`\`\n\n每次运行使用 mkdtemp 创建独立数据目录，通过生产 Bootstrap 初始化并持有目录锁；创建生产 createApp，等待 app.ready 后监听 127.0.0.1 随机端口。启动、编译和脚本执行均使用真实实现。\n\n恢复步骤使用编译后的 serializeSnapshot → parseSnapshot → ConfigRestoreService.preview → apply；不经过 Git 远端或 HTTP 恢复路由。本用例补充恢复后的执行能力验收，不替代既有 HTTP 恢复、传输及完整回归。快照包含固定版本脚本 restored-script-v1 和固定版本工作流 restored-workflow-v1；工作流先引用该脚本，再运行自己的 TypeScript 源码。\n\n源码顶层只向临时目录追加执行标记，并完成加法/倍增。恢复完成后确认标记文件不存在、runs 和 script_tests 均为空，然后才显式发起以下真实 HTTP 请求：\n\n- POST /api/scripts/restored-add/tests：{scriptVersionId:"restored-script-v1",input:{a:19,b:23},requestId:随机 UUID}。\n- GET /api/scripts/restored-add/tests/:testId：轮询至 succeeded，断言 sum=42、exitCode=0。\n- POST /api/workflows/restored-workflow/runs：{versionId:"restored-workflow-v1",input:{a:19,b:23},requestId:随机 UUID}。\n- GET /api/runs/:runId：轮询至 succeeded，断言 sum=42、doubled=84、两个节点均成功。\n\n额外校验三个执行标记的顺序、PID 与返回值一致，且为三个独立子进程，均不等于验收进程 PID。生产运行器自行编译源码并启动 Node 子进程；fixture 未替换编译器或进程执行器。\n\n实际观测（PID、端口和运行 ID 每次执行不同）：\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n\n清理：成功或失败均关闭 app、释放目录锁并删除全部临时数据；成功报告仅在清理完成且确认目录不存在后写出。没有外部服务或用户数据修改。\n`;
await writeFile(resolve('docs/features/2026-11-06-config-git-storage/runtime-verification.md'), report);
console.log(JSON.stringify(evidence, null, 2));
