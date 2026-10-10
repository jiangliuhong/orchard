import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository } from '../dist/storage/database.js';

async function until(check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw new Error('Timed out waiting for durable server');
}

test('default CLI server runs event -> sleep -> restart -> child on real same-process workers', { timeout: 25000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-server-durable-'));
  const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve));
  const db = initializeDatabase(dir), workflows = new WorkflowRepository(db);
  const workflow = workflows.createWorkflow({ id: 'durable-fixture', workspaceId: createDefaultWorkspace(db), name: 'Durable fixture' });
  await writeFile(join(dir, 'fixture.mjs'), `export default { id: 'fixture', name: 'Fixture', triggers: [{ type: 'event', config: { eventName: 'start' } }], inputSchema: {}, outputSchema: {}, async run(ctx, input) { if (input.child) return { child: true }; await ctx.step.sleep('server-sleep', 1800); await ctx.step.sendEvent('sent', { value: 1 }, { id: 'server-send' }); return ctx.step.invokeWorkflow('durable-fixture', { child: true }, { id: 'server-child' }); } };`);
  workflows.createVersion({ workflowId: workflow.id, contentHash: 'fixture', sourcePath: 'fixture.mjs', bundlePath: 'fixture.mjs', manifest: {}, sdkVersion: 'test' });
  db.close();
  let child;
  const url = `http://127.0.0.1:${port}`;
  const start = async () => {
    let output = '';
    child = spawn(process.execPath, ['dist/cli/main.js', 'start', '--port', String(port), '--data-dir', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    await until(() => { if (child.exitCode !== null) throw new Error(output); return output.includes('Orchard listening'); });
  };
  const stop = async () => { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  await start();
  const body = { source: 'test', id: '1', name: 'start', data: {} };
  const post = () => fetch(`${url}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  const response = await post(), runId = response.deliveries[0];
  assert.ok(runId);
  assert.deepEqual((await post()).deliveries, [runId]);
  await until(async () => (await fetch(`${url}/api/runs/${runId}`).then(r => r.json())).status === 'sleeping');
  await stop();
  await start();
  await until(async () => (await fetch(`${url}/api/runs/${runId}`).then(r => r.json())).status === 'succeeded');
  const history = await fetch(`${url}/api/runs/${runId}/events`).then(r => r.json());
  assert.ok(history.items.some(e => e.type === 'run.sleeping'));
  assert.ok(history.items.some(e => e.type === 'run.child_succeeded'));
  const health = await fetch(`${url}/api/worker/health`).then(r => r.json());
  assert.ok(health.workers.some(worker => worker.status === 'active'));
  assert.equal(health.queueDepth, 0);
  const createdResponse = await fetch(`${url}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Generated code workflow', description: 'Code description' }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const sourcePath = join(dir, 'workspaces/default/workflows', created.id, 'worker.ts');
  const source = await readFile(sourcePath, 'utf8');
  assert.ok(source.includes('Generated code workflow'));
  await writeFile(sourcePath, source.replace('Generated code workflow', 'Renamed in code'));
  const originalDetail = await fetch(`${url}/api/workflows/${created.id}`).then(response => response.json());
  assert.equal(originalDetail.workflow.name, 'Generated code workflow');
  const publishResponse = await fetch(`${url}/api/workflows/${created.id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: 'worker.ts' }) });
  assert.equal(publishResponse.status, 201, await publishResponse.text());
  const newDetail = await fetch(`${url}/api/workflows/${created.id}`).then(response => response.json());
  assert.equal(newDetail.workflow.name, 'Renamed in code');
  const newRun = await fetch(`${url}/api/workflows/${created.id}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(response => response.json());
  await until(async () => (await fetch(`${url}/api/runs/${newRun.id}`).then(response => response.json())).status === 'succeeded');
});
