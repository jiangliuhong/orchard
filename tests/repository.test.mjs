import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultWorkspace, initializeDatabase, RunRepository, WorkflowRepository } from "../dist/storage/database.js";

test("repositories bind runs to immutable versions and preserve ordered events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-repo-"));
  const db = initializeDatabase(dir);
  try {
    const workspaceId = createDefaultWorkspace(db);
    const workflows = new WorkflowRepository(db);
    const workflow = workflows.createWorkflow({ workspaceId, name: "Fixture" });
    const versionId = workflows.createVersion({ workflowId: workflow.id, contentHash: "hash-1", sourcePath: "source", bundlePath: "bundle", manifest: { id: "fixture" }, sdkVersion: "0.1.0" });
    assert.equal(workflows.listWorkflows(workspaceId).length, 1);
    const runs = new RunRepository(db);
    const run = runs.createRun({ workflowVersionId: versionId, inputRef: "input.json" });
    assert.equal(runs.appendEvent({ runId: run.id, type: "run.queued", payload: { safe: true } }), 1);
    assert.equal(runs.appendEvent({ runId: run.id, type: "run.started" }), 2);
    const claimed = runs.claimQueuedRun("worker-a", 10_000, 1);
    assert.equal(claimed.id, run.id);
    assert.equal(claimed.workflowVersionId, versionId);
    assert.equal(runs.claimQueuedRun("worker-b", 10_000, 2), undefined);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("historical versions are immutable and content hashes are unique", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-version-"));
  const db = initializeDatabase(dir);
  try {
    const workspaceId = createDefaultWorkspace(db);
    const workflows = new WorkflowRepository(db);
    const workflow = workflows.createWorkflow({ workspaceId, name: "Fixture" });
    const args = { workflowId: workflow.id, contentHash: "same", sourcePath: "a", bundlePath: "a", manifest: {}, sdkVersion: "0.1.0" };
    workflows.createVersion(args);
    assert.throws(() => workflows.createVersion(args), /UNIQUE/);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
