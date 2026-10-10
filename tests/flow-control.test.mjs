import { createCodeVersion } from "./helpers/code-version.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository } from '../dist/storage/database.js';
import { FlowControlRepository } from '../dist/scheduler/index.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-flow-')); const db = initializeDatabase(dir);
  t.after(() => { db.close(); return rm(dir, { recursive: true, force: true }); });
  const workflows = new WorkflowRepository(db), workflow = workflows.createWorkflow({ workspaceId: createDefaultWorkspace(db), name: 'flow' });
  const version = createCodeVersion(workflows, { workflowId: workflow.id, contentHash: 'flow', sourcePath: 'source', bundlePath: 'bundle', manifest: {}, sdkVersion: 'test' });
  return { db, workflow, version, runs: new RunRepository(db), flow: new FlowControlRepository(db, new RunRepository(db)) };
}

test('flow control persists rate buckets, debounce merges, and singleton skip/cancel decisions', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.flow.rateLimit('api', 1, 100, 1000), { allowed: true });
  assert.deepEqual(f.flow.rateLimit('api', 1, 100, 1001), { allowed: false, retryAt: 1100 });
  const first = f.flow.admit({ workflowId: f.workflow.id, policyKey: 'debounce', payload: { n: 1 }, debounceMs: 100 }, 1000);
  const merged = f.flow.admit({ workflowId: f.workflow.id, policyKey: 'debounce', payload: { n: 2 }, debounceMs: 100 }, 1050);
  assert.equal(first.decision, 'create'); assert.equal(merged.decision, 'merge'); assert.equal(merged.commandId, first.commandId);
  const run = f.runs.createRun({ workflowVersionId: f.version }); f.flow.bindSingleton('singleton', run.id, 'skip');
  assert.equal(f.flow.admit({ workflowId: f.workflow.id, policyKey: 'singleton', payload: {}, singleton: 'skip' }, 1100).decision, 'skip');
  const replacement = f.flow.admit({ workflowId: f.workflow.id, policyKey: 'singleton', payload: {}, singleton: 'cancel' }, 1101);
  assert.equal(replacement.decision, 'cancel'); assert.equal(f.runs.getRun(run.id).status, 'cancelled');
});
