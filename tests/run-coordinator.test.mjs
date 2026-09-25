import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultWorkspace, initializeDatabase, RunRepository, WorkflowRepository } from "../dist/storage/database.js";
import { RunCoordinator } from "../dist/runtime/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orchard-coordinator-"));
  const db = initializeDatabase(dir);
  const workspace = createDefaultWorkspace(db);
  const workflow = new WorkflowRepository(db).createWorkflow({ workspaceId: workspace, name: "fixture" });
  const version = new WorkflowRepository(db).createVersion({ workflowId: workflow.id, contentHash: Math.random().toString(), sourcePath: "source", bundlePath: "bundle", manifest: {}, sdkVersion: "0.1.0" });
  return { dir, db, runs: new RunRepository(db), version };
}

test("coordinator claims and finishes persisted runs", async () => {
  const f = await fixture();
  try {
    const run = f.runs.createRun({ workflowVersionId: f.version });
    const coordinator = new RunCoordinator(f.runs, { owner: "test", concurrency: 1 });
    const result = await coordinator.submit(run.id, async (claimed, signal) => {
      assert.equal(claimed.status, "running"); assert.equal(signal.aborted, false);
      return { outputRef: "artifact-1" };
    });
    assert.deepEqual(result, { runId: run.id, outputRef: "artifact-1" });
    assert.equal(f.runs.getRun(run.id).status, "succeeded");
    coordinator.close();
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("coordinator cancellation prevents late success from changing status", async () => {
  const f = await fixture();
  try {
    const run = f.runs.createRun({ workflowVersionId: f.version });
    const coordinator = new RunCoordinator(f.runs, { owner: "test" });
    const pending = coordinator.submit(run.id, async (_run, signal) => {
      await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return { outputRef: "late" };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.cancel(run.id), true);
    await assert.rejects(pending, /cancelled/);
    assert.equal(f.runs.getRun(run.id).status, "cancelled");
    assert.equal(coordinator.cancel(run.id), false);
    coordinator.close();
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("failed handlers are persisted as failed", async () => {
  const f = await fixture();
  try {
    const run = f.runs.createRun({ workflowVersionId: f.version });
    const coordinator = new RunCoordinator(f.runs);
    await assert.rejects(coordinator.submit(run.id, async () => { throw new Error("fixture failure"); }), /fixture failure/);
    assert.equal(f.runs.getRun(run.id).status, "failed");
    coordinator.close();
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});
