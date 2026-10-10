import { createCodeVersion } from "./helpers/code-version.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultWorkspace, initializeDatabase, WorkflowRepository, RunRepository, EventRepository } from '../dist/storage/database.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-delivery-'));
  const db = initializeDatabase(dir);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  const workflows = new WorkflowRepository(db);
  const workflow = workflows.createWorkflow({ workspaceId: createDefaultWorkspace(db), name: 'event fixture' });
  createCodeVersion(workflows, { workflowId: workflow.id, contentHash: 'one', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' }, { triggers: [{ type: "event", config: { eventName: "created" } }] });
  const runs = new RunRepository(db), events = new EventRepository(db);
  const createRun = (trigger, eventId) => runs.createRunForWorkflow({ workflowId: trigger.workflowId, idempotencyKey: `${eventId}:${trigger.id}`, triggerId: trigger.id }).id;
  return { db, workflows, workflow, runs, events, createRun };
}

test('matching event creates one version-bound run and duplicates return the same deliveries', async t => {
  const f = await fixture(t);
  const input = { source: 'test', eventId: '1', name: 'created', data: { ok: true }, createRun: f.createRun };
  const first = f.events.deliverMatching(input);
  assert.equal(first.deliveries.length, 1);
  const original = f.runs.getRun(first.deliveries[0]);
  createCodeVersion(f.workflows, { workflowId: f.workflow.id, contentHash: 'two', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' }, { triggers: [{ type: "event", config: { eventName: "created" } }] });
  const duplicate = f.events.deliverMatching(input);
  assert.equal(duplicate.event.duplicate, true);
  assert.deepEqual(duplicate.deliveries, first.deliveries);
  assert.equal(f.runs.listRuns().length, 1);
  assert.equal(f.runs.getRun(original.id).workflowVersionId, original.workflowVersionId);
  assert.throws(() => f.events.deliverMatching({ ...input, name: 'renamed' }), /conflicts/);
  assert.throws(() => f.events.deliverMatching({ ...input, data: { ok: false } }), /conflicts/);
});

test('failed delivery rolls back intake, runs and idempotency so redelivery can recover', async t => {
  const f = await fixture(t);
  const input = { source: 'test', eventId: '1', name: 'created', data: {} };
  assert.throws(() => f.events.deliverMatching({ ...input, createRun: (...args) => { f.createRun(...args); throw new Error('crash'); } }), /crash/);
  assert.equal(f.runs.listRuns().length, 0);
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM incoming_events').get().n, 0);
  assert.equal(f.db.database.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n, 0);
  assert.equal(f.events.deliverMatching({ ...input, createRun: f.createRun }).deliveries.length, 1);
});
