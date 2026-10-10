import { createCodeVersion } from "./helpers/code-version.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository, StepRepository, WorkflowTaskRepository, ScheduleRepository, PolicyBucketRepository } from '../dist/storage/database.js';
import { parseCron } from '../dist/scheduler/cron.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-durable-repo-'));
  const db = initializeDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const workflows = new WorkflowRepository(db);
  const workflow = workflows.createWorkflow({ workspaceId: createDefaultWorkspace(db), name: 'fixture' });
  const version = createCodeVersion(workflows, { workflowId: workflow.id, contentHash: 'test', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' }, { triggers: [{ type: 'cron', config: { expression: '0 * * * *', misfirePolicy: 'catch_up' } }] });
  const runs = new RunRepository(db), run = runs.createRun({ workflowVersionId: version });
  return { db, workflow, version, runs, run };
}

test('retry config drives task delay, exhaustion, and stale-result history', async t => {
  const f = await fixture(t), tasks = new WorkflowTaskRepository(f.db);
  const task = tasks.create({ runId: f.run.id, workflowVersionId: f.version, stepKey: 'retry', maxAttempts: 2, retryBackoff: 'fixed', retryInitialDelayMs: 500, retryMaxDelayMs: 1000 });
  const a = tasks.claim('a', 100, 1000);
  assert.equal(tasks.complete(a.lease.id, 'a', 1, 'failed', undefined, { message: 'retry' }, 1010), true);
  assert.equal(tasks.get(task.id).nextAttemptAt, 1510);
  assert.equal(tasks.claim('b', 100, 1509), undefined);
  const b = tasks.claim('b', 100, 1510);
  assert.equal(tasks.complete(a.lease.id, 'a', 1, 'succeeded', 'late', undefined, 1511), false);
  assert.equal(tasks.complete(b.lease.id, 'b', 1, 'failed', undefined, { message: 'exhausted' }, 1512), true);
  assert.equal(tasks.get(task.id).status, 'failed');
  assert.equal(tasks.claim('c', 100, 5000), undefined);
  assert.ok(f.runs.listEvents(f.run.id).some(e => e.type === 'task.stale_result'));
  assert.ok(f.runs.listEvents(f.run.id).some(e => e.type === 'task.retrying'));
});

test('step retry keeps logical identity and replay uses stable history, not lexical IDs or timestamps', async t => {
  const f = await fixture(t), steps = new StepRepository(f.db);
  const start = stepId => steps.beginStep({ runId: f.run.id, stepId, nodeType: 'test', nodeVersion: '1', config: {}, value: {} });
  let attempt = start('z-first');
  steps.finishStep({ ...attempt, status: 'failed', error: { message: 'transient' } });
  const firstId = attempt.stepRunId;
  attempt = start('z-first');
  assert.equal(attempt.stepRunId, firstId);
  assert.equal(attempt.attemptNo, 2);
  steps.finishStep({ ...attempt, status: 'succeeded', output: 42 });
  attempt = start('a-boundary');
  steps.finishStep({ ...attempt, status: 'succeeded', output: 99 });
  f.db.database.prepare('UPDATE step_runs SET created_at = 0').run();
  const before = f.runs.listEvents(f.run.id);
  const replay = f.runs.rerunFromStep(f.run.id, 'a-boundary');
  assert.equal(steps.getSuccessful(replay.id, 'z-first').output, 42);
  assert.equal(steps.getSuccessful(replay.id, 'a-boundary'), undefined);
  assert.deepEqual(f.runs.listEvents(f.run.id), before);
  assert.throws(() => f.runs.rerunFromStep(f.run.id, 'missing'), /LINEAGE/);
});

test('Cron timezone and DST occurrences use UTC identities', () => {
  assert.equal(parseCron('0 9 * * *', 'Asia/Shanghai').next(new Date('2025-01-01T00:00:00Z')).toISOString(), '2025-01-01T01:00:00.000Z');
  const fall = parseCron('30 1 * * *', 'America/New_York');
  assert.equal(fall.next(new Date('2025-11-02T05:30:00Z')).toISOString(), '2025-11-02T06:30:00.000Z');
  const spring = parseCron('30 2 * * *', 'America/New_York');
  assert.equal(spring.next(new Date('2025-03-09T06:59:00Z')).toISOString(), '2025-03-10T06:30:00.000Z');
});

test('Cron cursor retains undelivered occurrences and skip records misfires', async t => {
  const f = await fixture(t), schedules = new ScheduleRepository(f.db);
  const schedule = schedules.list()[0];
  assert.throws(() => schedules.setEnabled(schedule.id, true), /源码/);
  const until = new Date('2025-01-01T03:00:00Z'), from = new Date('2025-01-01T00:00:00Z');
  const planned = schedules.planDue(schedule.id, until, from);
  assert.equal(planned.length, 3);
  assert.deepEqual(schedules.planDue(schedule.id, until), planned);
  schedules.deliverOccurrence(schedule.id, planned[0].occurrenceKey, f.run.id);
  assert.equal(schedules.planDue(schedule.id, until).length, 2);
  createCodeVersion(new WorkflowRepository(f.db), { workflowId: f.workflow.id, contentHash: 'skip', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' }, { triggers: [{ type: 'cron', config: { expression: '0 * * * *', misfirePolicy: 'skip' } }] });
  const skip = schedules.list()[0];
  assert.equal(schedules.planDue(skip.id, until, from).length, 1);
  assert.equal(f.db.database.prepare("SELECT COUNT(*) AS n FROM schedule_occurrences WHERE schedule_id = ? AND status = 'skipped'").get(skip.id).n, 2);
});

test('rate bucket handles same timestamp and exact window boundary', async t => {
  const f = await fixture(t), bucket = new PolicyBucketRepository(f.db);
  assert.equal(bucket.consume('key', { limit: 1, periodMs: 100, now: 1000 }).allowed, true);
  assert.deepEqual(bucket.consume('key', { limit: 1, periodMs: 100, now: 1000 }), { allowed: false, retryAt: 1100 });
  assert.equal(bucket.consume('key', { limit: 1, periodMs: 100, now: 1100 }).allowed, true);
  assert.throws(() => bucket.consume('bad', { limit: 0, periodMs: 100 }), /Invalid/);
});

test('serialized results fence mismatched run, attempt, worker, lease and version', async t => {
  const f = await fixture(t), tasks = new WorkflowTaskRepository(f.db);
  tasks.create({ runId: f.run.id, workflowVersionId: f.version, stepKey: 'protocol' });
  const claimed = tasks.claim('worker', 1000, 1000);
  const result = { taskId: claimed.task.id, runId: f.run.id, attemptId: claimed.lease.attemptId, leaseId: claimed.lease.id, workerId: 'worker', leaseVersion: 1, status: 'succeeded', output: 42 };
  for (const [field, bad] of [['runId', 'other'], ['attemptId', 'other'], ['workerId', 'other'], ['leaseId', 'other'], ['leaseVersion', 2]]) assert.equal(tasks.acceptResult({ ...result, [field]: bad }, 1001), false);
  assert.equal(tasks.acceptResult(JSON.parse(JSON.stringify(result)), 1001), true);
  assert.equal(tasks.acceptResult(result, 1002), false);
});

test('priority claims stable order and health reports actual persisted workers and recovery', async t => {
  const f = await fixture(t), tasks = new WorkflowTaskRepository(f.db);
  const low = tasks.create({ runId: f.run.id, workflowVersionId: f.version, stepKey: 'low', priority: 0 });
  const high = tasks.create({ runId: f.run.id, workflowVersionId: f.version, stepKey: 'high', priority: 10 });
  const claimed = tasks.claim('worker', 10, 1000);
  assert.equal(claimed.task.id, high.id);
  tasks.heartbeatWorker('worker', 1);
  assert.equal(tasks.health(1001).activeLeases, 1);
  assert.equal(tasks.health().workers.length, 1);
  tasks.recoverExpired(1011);
  assert.ok(tasks.health().recovery.lastRun);
  assert.equal(tasks.get(low.id).status, 'queued');
});
