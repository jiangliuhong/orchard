import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodeVersion } from './helpers/code-version.mjs';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository, ScheduleRepository, EventRepository } from '../dist/storage/database.js';
import { createServer } from '../dist/server/app.js';

test('workflow deletion preserves code and history, prevents new runs and stops triggers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-delete-'));
  const db = initializeDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const workspaceId = createDefaultWorkspace(db), workflows = new WorkflowRepository(db), runs = new RunRepository(db);
  const workflow = workflows.createWorkflow({ workspaceId, name: 'Fixture' });
  const args = { workflowId: workflow.id, contentHash: 'delete', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' };
  const versionId = createCodeVersion(workflows, args, { triggers: [{ type: 'event', config: { eventName: 'created' } }, { type: 'cron', config: { expression: '@daily' } }] });
  const run = runs.createRun({ workflowVersionId: versionId });
  assert.throws(() => workflows.deleteWorkflow(workflow.id, workspaceId), { name: 'WORKFLOW_BUSY' });
  assert.equal(workflows.getWorkflow(workflow.id).status, 'active');
  assert.equal(workflows.deleteWorkflow(workflow.id, 'other-workspace'), false);
  runs.requestCancel(run.id, 'Test cancellation');
  const version = workflows.getVersion(versionId), history = runs.listEvents(run.id);
  const source = await readFile(version.sourcePath, 'utf8');
  assert.equal(workflows.deleteWorkflow(workflow.id, workspaceId), true);
  assert.equal(workflows.getWorkflow(workflow.id), undefined);
  assert.equal(workflows.getWorkflow(workflow.id, workspaceId, true).status, 'deleted');
  assert.deepEqual(workflows.listWorkflows(workspaceId), []);
  assert.equal(await readFile(version.sourcePath, 'utf8'), source);
  assert.deepEqual(runs.listEvents(run.id), history);
  assert.equal(runs.getRun(run.id).status, 'cancelled');
  assert.deepEqual(new ScheduleRepository(db).listEnabled(), []);
  assert.deepEqual(new EventRepository(db).deliverMatching({ source: 'test', eventId: '1', name: 'created', data: {}, createRun() { throw new Error('Deleted workflow must not trigger'); } }).deliveries, []);
  assert.throws(() => runs.createRun({ workflowVersionId: versionId }), /WORKFLOW_NOT_FOUND/);
  assert.throws(() => runs.createRunForWorkflow({ workflowId: workflow.id, workflowVersionId: versionId }), /WORKFLOW_NOT_FOUND/);
  assert.equal(workflows.activateVersion(workflow.id, versionId), false);
  assert.throws(() => createCodeVersion(workflows, { ...args, contentHash: 'deleted-new-version' }), /WORKFLOW_NOT_FOUND/);
  assert.equal(workflows.deleteWorkflow(workflow.id, workspaceId), false);
});

test('workflow delete API reports success, missing storage, missing workflow and active runs', async t => {
  const app = createServer({ deleteWorkflow(id) {
    if (id === 'busy') throw Object.assign(new Error('请先取消运行'), { name: 'WORKFLOW_BUSY' });
    return id === 'fixture';
  } });
  t.after(() => app.close());
  const success = await app.inject({ method: 'DELETE', url: '/api/workflows/fixture' });
  assert.equal(success.statusCode, 204);
  assert.equal(success.body, '');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/workflows/missing' })).statusCode, 404);
  const busy = await app.inject({ method: 'DELETE', url: '/api/workflows/busy' });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'WORKFLOW_BUSY');
  const unavailable = createServer();
  t.after(() => unavailable.close());
  assert.equal((await unavailable.inject({ method: 'DELETE', url: '/api/workflows/fixture' })).statusCode, 503);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/workflows/fixture', headers: { origin: 'https://evil.example' } })).statusCode, 403);
});
