import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository, ScheduleRepository, EventRepository, WorkflowTaskRepository } from '../dist/storage/database.js';
import { readSourceConfiguration } from '../dist/authoring/source-configuration.js';
import { publishWorkflow } from '../dist/authoring/publish.js';
import { createServer } from '../dist/server/app.js';

async function fixture(t, configuration = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-code-config-'));
  const db = initializeDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const workflows = new WorkflowRepository(db);
  const workflow = workflows.createWorkflow({ id: 'source-fixture', workspaceId: createDefaultWorkspace(db), name: 'DB name', description: 'DB description' });
  const rootDir = join(dir, 'workspaces/default/workflows/source-fixture');
  await mkdir(rootDir, { recursive: true });
  const source = `import { defineWorkflow } from '@jiangliuhong/orchard/workflow';
export default defineWorkflow({ id: 'source-fixture', ...${JSON.stringify({ name: 'Code name', description: 'Code description', ...configuration })}, inputSchema: {}, outputSchema: {}, async run() { return {}; } });`;
  await writeFile(join(rootDir, 'worker.ts'), source);
  const publish = () => publishWorkflow({ workflows, workflowId: workflow.id, rootDir, entry: 'worker.ts', outputDir: join(dir, 'versions/source-fixture') });
  const published = await publish();
  return { db, dir, workflows, workflow, rootDir, source, publish, version: workflows.getVersion(published.versionId), runs: new RunRepository(db), schedules: new ScheduleRepository(db), events: new EventRepository(db), tasks: new WorkflowTaskRepository(db) };
}

test('source configuration statically reads local constants and rejects dynamic configuration', () => {
  const config = readSourceConfiguration('worker.ts', `const retry = { maxAttempts: 2 }; const policy = { retry }; export default defineWorkflow({ name: 'Code', policy, triggers: [{ type: 'cron', config: { expression: '@daily', timezone: 'Asia/Shanghai' } }], concurrency: 1 });`);
  assert.equal(config.name, 'Code');
  assert.deepEqual(config.policy.retry, { maxAttempts: 2 });
  for (const field of ["name: compute()", "description: external", "policy: readPolicy()", "triggers: imported", "concurrency: process.env.CONCURRENCY", "policy: null", "triggers: {}", "triggers: [{ type: 'cron', config: { expression: 'invalid' } }]"]) {
    assert.throws(() => readSourceConfiguration('worker.ts', `export default defineWorkflow({ ${field} });`));
  }
  assert.throws(() => readSourceConfiguration('worker.ts', 'const policy = { retry: policy }; export default defineWorkflow({ policy });'));
});

test('publication writes code-derived backups, preserves version source, and rejects override channels', async t => {
  const f = await fixture(t, { policy: { retry: { maxAttempts: 2 } } });
  const backup = f.db.database.prepare('SELECT execution_config_json AS config FROM workflow_versions WHERE id = ?').get(f.version.id);
  assert.equal(JSON.parse(backup.config).name, 'Code name');
  assert.equal(JSON.parse(backup.config).policy.retry.maxAttempts, 2);
  await assert.rejects(publishWorkflow({ workflows: f.workflows, workflowId: f.workflow.id, rootDir: f.rootDir, entry: 'worker.ts', outputDir: join(f.dir, 'versions'), manifest: { executionConfig: { retry: { maxAttempts: 99 } } } }), { name: 'SOURCE_DEFINITION_READ_ONLY' });
  assert.throws(() => f.workflows.createVersion({ ...f.version, workflowId: f.workflow.id, executionConfig: {} }), { name: 'SOURCE_DEFINITION_READ_ONLY' });
  await writeFile(join(f.rootDir, 'worker.ts'), f.source.replaceAll('Code name', 'New code name'));
  assert.equal(f.workflows.getWorkflow(f.workflow.id).name, 'Code name');
  const next = await f.publish();
  assert.equal(f.workflows.getWorkflow(f.workflow.id).name, 'New code name');
  assert.equal(f.workflows.getSourceConfiguration(f.version.id).name, 'Code name');
  f.workflows.activateVersion(f.workflow.id, f.version.id);
  assert.equal(f.workflows.getWorkflow(f.workflow.id).name, 'Code name');
  assert.notEqual(next.versionId, f.version.id);
});

test('database backup edits never change names, policy, event routing, or Cron configuration', async t => {
  const f = await fixture(t, {
    concurrency: 1, policy: { retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 200 } },
    triggers: [{ type: 'event', config: { eventName: 'created' } }, { type: 'cron', config: { expression: '@hourly', timezone: 'Asia/Shanghai', enabled: true, misfirePolicy: 'catch_up' } }],
  });
  f.db.database.prepare("UPDATE workflows SET name = 'changed', description = 'changed' WHERE id = ?").run(f.workflow.id);
  f.db.database.prepare("UPDATE workflow_versions SET execution_config_json = '{\"concurrency\":99,\"policy\":{\"retry\":{\"maxAttempts\":99}}}' WHERE id = ?").run(f.version.id);
  f.db.database.prepare("UPDATE triggers SET enabled = 0, config_json = '{\"eventName\":\"changed\"}'").run();
  f.db.database.prepare("UPDATE schedules SET enabled = 0, expression = '@daily', timezone = 'UTC'").run();
  assert.equal(f.workflows.getWorkflow(f.workflow.id).name, 'Code name');
  assert.equal(f.workflows.listWorkflows(f.workflow.workspaceId)[0].description, 'Code description');
  assert.equal(f.workflows.getVersion(f.version.id).executionConfig.concurrency, 1);
  const schedule = f.schedules.listEnabled()[0];
  assert.equal(schedule.expression, '@hourly');
  assert.equal(schedule.timezone, 'Asia/Shanghai');
  const createRun = (trigger, eventId) => f.runs.createRunForWorkflow({ workflowId: trigger.workflowId, workflowVersionId: trigger.workflowVersionId, triggerId: trigger.id, idempotencyKey: `${eventId}:${trigger.id}` }).id;
  assert.equal(f.events.deliverMatching({ source: 'test', eventId: 'changed', name: 'changed', data: {}, createRun }).deliveries.length, 0);
  const result = f.events.deliverMatching({ source: 'test', eventId: 'created', name: 'created', data: {}, createRun });
  assert.equal(result.deliveries.length, 1);
  const first = f.tasks.enqueueRun(result.deliveries[0]);
  assert.equal(first.maxAttempts, 2);
  assert.equal(first.retryInitialDelayMs, 200);
  const secondRun = f.runs.createRun({ workflowVersionId: f.version.id });
  f.tasks.enqueueRun(secondRun.id);
  assert.ok(f.tasks.claim('worker', 1000));
  assert.equal(f.tasks.claim('other', 1000), undefined);
});

test('cancelOn is read from the run-bound source rather than a modified backup', async t => {
  const f = await fixture(t, { policy: { cancelOn: [{ event: 'stop' }] } });
  const run = f.runs.createRun({ workflowVersionId: f.version.id });
  f.db.database.prepare("UPDATE workflow_versions SET execution_config_json = '{}' WHERE id = ?").run(f.version.id);
  f.events.deliverMatching({ source: 'test', eventId: 'stop', name: 'stop', data: {}, createRun() { throw new Error('No trigger'); } });
  assert.equal(f.runs.getRun(run.id).status, 'cancelled');
});

test('source-backed schedules and metadata have no direct mutation route', async t => {
  const f = await fixture(t, { triggers: [{ type: 'cron', config: { expression: '@daily' } }] });
  const schedule = f.schedules.list()[0];
  for (const action of [() => f.schedules.create({ workflowId: f.workflow.id, expression: '@hourly' }), () => f.schedules.setEnabled(schedule.id, false), () => f.schedules.update(schedule.id, { expression: '@hourly' }), () => f.schedules.delete(schedule.id)]) {
    assert.throws(action, { name: 'SOURCE_DEFINITION_READ_ONLY' });
  }
  let called = false;
  const app = createServer({ createSchedule() { called = true; }, setScheduleEnabled() { called = true; return true; } });
  t.after(() => app.close());
  for (const [method, url, payload] of [['POST', '/api/schedules', { workflowId: f.workflow.id, expression: '@hourly' }], ['POST', `/api/schedules/${schedule.id}/enabled`, { enabled: false }], ['PATCH', '/api/workflows/source-fixture', { name: 'changed', policy: {} }]]) {
    const response = await app.inject({ method, url, payload });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'SOURCE_DEFINITION_READ_ONLY');
  }
  assert.equal(called, false);
});

test('missing or changed published source cannot fall back to database policy', async t => {
  const f = await fixture(t, { policy: { retry: { maxAttempts: 2 } } });
  const run = f.runs.createRun({ workflowVersionId: f.version.id });
  const path = join(f.dir, f.version.sourcePath, 'worker.ts');
  const original = await readFile(path, 'utf8');
  await writeFile(path, original + '\n// changed');
  assert.throws(() => f.tasks.enqueueRun(run.id), /digest mismatch/);
  await rm(path);
  assert.throws(() => f.tasks.enqueueRun(run.id));
  assert.equal(f.workflows.getWorkflow(f.workflow.id).name, f.workflow.id);
  assert.equal(f.workflows.getWorkflow(f.workflow.id).description, '');
  assert.equal(f.tasks.list(run.id).length, 0);
});
