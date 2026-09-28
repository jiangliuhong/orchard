import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkerLoop } from "../dist/runtime/index.js";
import { AuthoringSessionRepository, ScheduleRepository, WorkflowTaskRepository, createDefaultWorkspace, initializeDatabase, WorkflowRepository, RunRepository } from "../dist/storage/database.js";

test("persistent task leases are exclusive and recover after expiry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-task-")); const db = initializeDatabase(dir);
  try {
    const workspaceId = createDefaultWorkspace(db); const workflows = new WorkflowRepository(db); const workflow = workflows.createWorkflow({ workspaceId, name: "task" });
    const version = workflows.createVersion({ workflowId: workflow.id, contentHash: "task", sourcePath: "source", bundlePath: "bundle", manifest: {}, sdkVersion: "test" });
    const run = new RunRepository(db).createRun({ workflowVersionId: version }); const tasks = new WorkflowTaskRepository(db); tasks.create({ runId: run.id, workflowVersionId: version, stepKey: "one" });
    const first = tasks.claim("worker-a", 10, 1000); assert.ok(first); assert.equal(tasks.claim("worker-b", 10, 1000), undefined); assert.equal(tasks.heartbeat(first.lease.id, "worker-a", first.lease.leaseVersion, 10, 1001), true); assert.equal(tasks.complete(first.lease.id, "worker-a", 2, "succeeded", { ok: true }, undefined, 1002), true); const second = tasks.create({ runId: run.id, workflowVersionId: version, stepKey: "two" }); assert.equal(second.status, "queued"); const expired = tasks.claim("worker-a", 1, 2000); assert.ok(expired); assert.equal(tasks.recoverExpired(2002), 1); assert.ok(tasks.claim("worker-b", 10, 2003));
    const loopTask = tasks.create({ runId: run.id, workflowVersionId: version, stepKey: "loop" }); const loop = new WorkerLoop(tasks, async () => ({ done: true }), { workerId: "loop-worker", concurrency: 1, pollMs: 5 }); loop.start(); await new Promise((resolve) => setTimeout(resolve, 30)); loop.close(); const status = db.database.prepare("SELECT status FROM workflow_tasks WHERE id = ?").get(loopTask.id); assert.equal(status.status, "succeeded");
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("schedule and authoring session state transitions are persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-state-")); const db = initializeDatabase(dir);
  try {
    const workspaceId = createDefaultWorkspace(db); const workflows = new WorkflowRepository(db); const workflow = workflows.createWorkflow({ workspaceId, name: "state" }); const version = workflows.createVersion({ workflowId: workflow.id, contentHash: "state-v1", sourcePath: "source", bundlePath: "bundle", manifest: {}, sdkVersion: "test" }); const run = new RunRepository(db).createRun({ workflowVersionId: version }); const draft = workflows.createDraft({ workspaceId, workflowId: workflow.id, rootPath: dir });
    const schedules = new ScheduleRepository(db); const schedule = schedules.create({ workflowId: workflow.id, expression: "0 * * * *" }); assert.equal(schedules.setEnabled(schedule.id, true), true); assert.equal(schedules.get(schedule.id)?.enabled, true); const planned = schedules.planDue(schedule.id, new Date("2025-01-01T02:00:00Z"), new Date("2025-01-01T00:00:00Z")); assert.equal(planned.length, 2); assert.equal(schedules.deliverOccurrence(schedule.id, planned[0].occurrenceKey, run.id), true); assert.equal(schedules.deliverOccurrence(schedule.id, planned[0].occurrenceKey, run.id), false);
    const sessions = new AuthoringSessionRepository(db); const session = sessions.create({ workspaceId, draftId: draft }); assert.equal(sessions.transition(session.id, "running"), true); assert.throws(() => sessions.transition(session.id, "pending"), /Invalid authoring/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
