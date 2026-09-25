import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultWorkspace, initializeDatabase, RunRepository, StepRepository, WorkflowRepository } from "../dist/storage/database.js";
import { NodeRegistry, Type, defineWorkflow } from "../dist/workflow-sdk/index.js";
import { WorkflowExecutionService } from "../dist/runtime/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orchard-execution-"));
  const db = initializeDatabase(dir);
  const workspace = createDefaultWorkspace(db);
  const workflows = new WorkflowRepository(db);
  const workflowRecord = workflows.createWorkflow({ workspaceId: workspace, name: "fixture" });
  const version = workflows.createVersion({ workflowId: workflowRecord.id, contentHash: Math.random().toString(), sourcePath: "source", bundlePath: "bundle", manifest: {}, sdkVersion: "0.1.0" });
  const nodes = new NodeRegistry().register({ type: "fixture.upper", version: "1", configSchema: Type.Object({}), inputSchema: Type.String(), outputSchema: Type.String(), async execute(_ctx, _config, input) { return input.toUpperCase(); } });
  const workflow = defineWorkflow({ id: "fixture", name: "Fixture", inputSchema: Type.Object({ text: Type.String() }), outputSchema: Type.Object({ value: Type.String() }), async run(ctx, input) { const value = await ctx.step.execute("uppercase", { type: "fixture.upper", config: {}, input: input.text }); return { value }; } });
  return { dir, db, version, runs: new RunRepository(db), workflow, nodes };
}

test("workflow execution validates and persists each step attempt", async () => {
  const f = await fixture();
  try {
    const run = f.runs.createRun({ workflowVersionId: f.version });
    const result = await new WorkflowExecutionService(f.db, f.nodes).execute(run.id, f.workflow, { text: "hello" }, new AbortController().signal);
    assert.deepEqual(result, { value: "HELLO" });
    const row = f.db.database.prepare("SELECT status, output_ref FROM step_runs WHERE run_id = ?").get(run.id);
    assert.equal(row.status, "succeeded");
    assert.equal(JSON.parse(row.output_ref), "HELLO");
    assert.equal(f.db.database.prepare("SELECT COUNT(*) AS count FROM step_attempts WHERE step_run_id = (SELECT id FROM step_runs WHERE run_id = ?)").get(run.id).count, 1);
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});

test("workflow execution records failed and cancelled attempts", async () => {
  const f = await fixture();
  try {
    const failing = defineWorkflow({ id: "failing", name: "Failing", inputSchema: {}, outputSchema: {}, async run(ctx) { await ctx.step.execute("bad", { type: "fixture.upper", config: {}, input: 1 }); return {}; } });
    const run = f.runs.createRun({ workflowVersionId: f.version });
    await assert.rejects(new WorkflowExecutionService(f.db, f.nodes).execute(run.id, failing, {}, new AbortController().signal), /input validation/);
    assert.equal(f.db.database.prepare("SELECT status FROM step_runs WHERE run_id = ?").get(run.id).status, "failed");
  } finally { f.db.close(); await rm(f.dir, { recursive: true, force: true }); }
});
