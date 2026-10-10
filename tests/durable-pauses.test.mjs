import { createCodeVersion } from "./helpers/code-version.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository, ContinuationRepository, EventRepository } from '../dist/storage/database.js';
import { WorkflowExecutionService } from '../dist/runtime/workflow-execution.js';
import { RunCoordinator } from '../dist/runtime/run-coordinator.js';
import { NodeRegistry } from '../dist/workflow-sdk/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-pause-'));
  let db = initializeDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const workflows = new WorkflowRepository(db);
  const workflow = workflows.createWorkflow({ workspaceId: createDefaultWorkspace(db), name: 'pause' });
  const version = createCodeVersion(workflows, { workflowId: workflow.id, contentHash: 'pause', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' });
  const run = new RunRepository(db).createRun({ workflowVersionId: version });
  return { get db() { return db; }, run, restart() { db.close(); db = initializeDatabase(dir); } };
}
async function execute(f, handler, nodes = new NodeRegistry(), policy) {
  const runs = new RunRepository(f.db);
  const coordinator = new RunCoordinator(runs);
  const execution = new WorkflowExecutionService(f.db, nodes);
  try { return await coordinator.submit(f.run.id, async (run, signal) => ({ outputRef: JSON.stringify(await execution.execute(run.id, { id: 'pause', name: 'Pause', inputSchema: {}, outputSchema: {}, policy, run: handler }, {}, signal)) })); }
  finally { coordinator.close(); }
}

test('sleep persists its deadline, releases coordinator and resumes after restart exactly once', async t => {
  const f = await fixture(t);
  let completed = 0;
  const workflow = async ctx => { await ctx.step.sleep('pause', 1000); completed++; return 'done'; };
  await execute(f, workflow);
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'sleeping');
  const deadline = new ContinuationRepository(f.db).list(f.run.id)[0].resumeAt;
  f.restart();
  const pauses = new ContinuationRepository(f.db);
  assert.equal(pauses.resumeDue(deadline - 1), 0);
  assert.equal(pauses.resumeDue(deadline), 1);
  assert.equal(pauses.resumeDue(deadline), 0);
  await execute(f, workflow);
  assert.equal(completed, 1);
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'succeeded');
});

// Regression remains failing until the stable-operation-ID SDK decision is resolved.
test('parallel branches retain their own pause identity when memoization changes completion order', async t => {
  const f = await fixture(t);
  const finished = [];
  const deadline = Date.now() + 10000;
  const nodes = new NodeRegistry().register({ type: 'ordering.node', version: '1', configSchema: {}, inputSchema: {}, outputSchema: {}, async execute(_ctx, _config, input) { if (input === 'a') await new Promise(resolve => setTimeout(resolve, 25)); return input; } });
  const workflow = async ctx => {
    await Promise.all(['a', 'b'].map(async name => {
      await ctx.step.run(name, { type: 'ordering.node', config: {}, input: name });
      await ctx.step.sleepUntil(name, name === 'a' ? deadline + 10000 : deadline);
      finished.push(name);
    }));
    return 'done';
  };
  await execute(f, workflow, nodes);
  const pauses = new ContinuationRepository(f.db);
  assert.equal(pauses.list(f.run.id).length, 2);
  pauses.resumeDue(deadline);
  await execute(f, workflow, nodes);
  assert.deepEqual(finished, ['b']);
});

test('event wait matches key once; duplicate intake cannot resume it again', async t => {
  const f = await fixture(t);
  let received;
  const workflow = async ctx => { received = await ctx.step.waitForEvent('ready', { id: 'payment-ready', key: 'a', timeoutMs: 50000 }); return received; };
  await execute(f, workflow);
  f.restart();
  const events = new EventRepository(f.db);
  const input = { source: 'test', eventId: '1', name: 'ready', data: { key: 'a', result: 42 }, createRun() { throw new Error('No trigger expected'); } };
  events.deliverMatching({ ...input, eventId: 'wrong', data: { key: 'b' } });
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'waiting');
  events.deliverMatching(input);
  events.deliverMatching(input);
  await execute(f, workflow);
  assert.deepEqual(received, input.data);
  assert.equal(new ContinuationRepository(f.db).list(f.run.id).length, 1);
});

test('wait timeout returns null and cancellation prevents deadline resurrection', async t => {
  const f = await fixture(t);
  let received = 'unset';
  const workflow = async ctx => { received = await ctx.step.waitForEvent('ready', { id: 'timeout-ready', timeoutMs: 100 }); return received; };
  await execute(f, workflow);
  const pauses = new ContinuationRepository(f.db);
  pauses.resumeDue(pauses.list(f.run.id)[0].resumeAt);
  await execute(f, workflow);
  assert.equal(received, null);
  const second = new RunRepository(f.db).createRun({ workflowVersionId: f.run.workflowVersionId });
  new RunRepository(f.db).claimRun(second.id, 'test', 1000, 1);
  pauses.create({ runId: second.id, stepKey: 's', kind: 'sleep', idempotencyKey: 'cancelled', resumeAt: 0 });
  pauses.pause(second.id, 'sleeping');
  new RunRepository(f.db).requestCancel(second.id, 'stop');
  assert.equal(pauses.resumeDue(Date.now()), 0);
  assert.equal(pauses.getByKey('cancelled').status, 'cancelled');
});

test('invoke persists child linkage and resumes parent with child output after restart', async t => {
  const f = await fixture(t), workflows = new WorkflowRepository(f.db);
  const parentVersion = workflows.getVersion(f.run.workflowVersionId);
  let received;
  const workflow = async ctx => { received = await ctx.step.invokeWorkflow(parentVersion.workflowId, { value: 7 }, { id: 'child-invoice' }); return received; };
  await execute(f, workflow);
  const link = f.db.database.prepare('SELECT child_run_id AS id FROM run_links WHERE parent_run_id = ?').get(f.run.id);
  assert.ok(link);
  f.restart();
  const runs = new RunRepository(f.db);
  runs.claimRun(link.id, 'child-worker', 1000, 1);
  runs.finish(link.id, 'succeeded', JSON.stringify({ value: 14 }));
  const pauses = new ContinuationRepository(f.db);
  assert.equal(pauses.resumeChildren(), 1);
  assert.equal(pauses.resumeChildren(), 0);
  await execute(f, workflow);
  assert.deepEqual(received, { value: 14 });
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM run_links').get().n, 1);
});

test('send event uses a stable identity when replaying across a sleep', async t => {
  const f = await fixture(t);
  const ids = [];
  const workflow = async ctx => { ids.push(await ctx.step.sendEvent('sent', { value: 1 }, { id: 'send-once' })); await ctx.step.sleep('after-send', 10); return 'done'; };
  await execute(f, workflow);
  f.restart();
  const pauses = new ContinuationRepository(f.db);
  pauses.resumeDue(pauses.list(f.run.id)[0].resumeAt);
  await execute(f, workflow);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM incoming_events').get().n, 1);
});

test('runtime retry releases coordinator, persists backoff and memoizes successful predecessors', async t => {
  const f = await fixture(t);
  let good = 0, attempts = 0;
  const nodes = new NodeRegistry().register({ type: 'test.node', version: '1', configSchema: {}, inputSchema: {}, outputSchema: {}, async execute(_ctx, _config, input) { if (input === 'good') { good++; return 7; } if (++attempts < 3) throw new Error('transient'); return 42; } });
  const workflow = async ctx => { await ctx.step.run('first', { type: 'test.node', config: {}, input: 'good' }); return ctx.step.run('second', { type: 'test.node', config: {}, input: 'bad' }); };
  const policy = { retry: { maxAttempts: 3, initialDelayMs: 1000, backoff: 'fixed' } };
  for (let i = 0; i < 2; i++) {
    await execute(f, workflow, nodes, policy);
    assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'retrying');
    f.restart();
    const pauses = new ContinuationRepository(f.db);
    const pending = pauses.list(f.run.id).find(p => p.status === 'waiting');
    assert.equal(pauses.resumeDue(pending.resumeAt - 1), 0);
    pauses.resumeDue(pending.resumeAt);
  }
  await execute(f, workflow, nodes, policy);
  assert.equal(attempts, 3);
  assert.equal(good, 1);
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'succeeded');
});

test('parallel sleeps keep independent durable identities', async t => {
  const f = await fixture(t);
  const workflow = async ctx => { await Promise.all([ctx.step.sleep('branch-a', 100), ctx.step.sleep('branch-b', 200)]); return 'ok'; };
  await execute(f, workflow);
  const pauses = new ContinuationRepository(f.db);
  assert.equal(pauses.list(f.run.id).length, 2);
  const deadlines = pauses.list(f.run.id).map(p => p.resumeAt);
  pauses.resumeDue(Math.min(...deadlines));
  await execute(f, workflow);
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'sleeping');
  pauses.resumeDue(Math.max(...deadlines));
  await execute(f, workflow);
  assert.equal(new RunRepository(f.db).getRun(f.run.id).status, 'succeeded');
});
