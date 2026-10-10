import { createCodeVersion } from "./helpers/code-version.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalNodeRegistry } from "../dist/runtime/local-nodes.js";
import { registerMetricNodes } from "../dist/integrations/metric/nodes.js";
import { NodeRegistry, defineWorkflow } from "../dist/workflow-sdk/index.js";
import { StepRunner, WorkflowExecutionService } from "../dist/runtime/index.js";
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository, RunRepository } from "../dist/storage/database.js";

const config = { profile: "pt", projectId: 7, taskId: 73, taskName: "资金成本与融资成本差额", model: "pl_nonoperate_expense_monthly_snapshot" };
const task = { id: 73, projectId: 7, name: config.taskName, target: config.model, type: "model", currentExecution: null };
const record = (id, status = "success", extra = {}) => ({ id, status, scheduleTaskId: 73, responseData: { data: { dbt: { output: "dbt completed" } } }, ...extra });
const page = records => ({ records, total: records.length });
const options = { runId: "run", stepId: "step", attemptId: "attempt" };
const pollInput = { baseline: 100, executionId: null, deadline: Date.now() + 120_000 };
const pollConfig = { profile: "pt", taskId: 73, maxOutputBytes: 1024 * 1024 };

test("local worker registers all nodes used by the funding workflow and sleep supports cancellation", async () => {
  const nodes = createLocalNodeRegistry();
  for (const type of ["metric.task.submit", "metric.task.poll", "core.sleep"]) assert.ok(nodes.has(type));
  const runner = new StepRunner(nodes);
  assert.equal(await runner.execute(options, { type: "core.sleep", config: {}, input: { durationMs: 0 } }), null);
  const controller = new AbortController();
  const sleeping = runner.execute({ ...options, signal: controller.signal }, { type: "core.sleep", config: {}, input: { durationMs: 10_000 } });
  controller.abort();
  await assert.rejects(sleeping, /abort/i);
});

test("metric submit checks identity and history before submitting exactly once", async () => {
  const calls = [];
  const nodes = registerMetricNodes(new NodeRegistry(), (profile, context) => {
    assert.equal(profile, "pt"); assert.equal(context.runId, "run");
    return async args => { calls.push(args); return args[1] === "list" ? page([task]) : args[1] === "history" ? page([record(100)]) : {}; };
  });
  const output = await new StepRunner(nodes).execute(options, { type: "metric.task.submit", config, input: {} });
  assert.equal(output.baseline, 100);
  assert.ok(output.deadline > Date.now());
  assert.deepEqual(calls.map(args => args[1]), ["list", "history", "run"]);
  assert.deepEqual(calls[2], ["task", "run", "--id", "73"]);
});

test("metric submit refuses identity changes, active executions and ambiguous submission failures", async () => {
  for (const changed of [{ ...task, target: "different" }, { ...task, currentExecution: 12 }, task]) {
    let submitted = 0;
    const nodes = registerMetricNodes(new NodeRegistry(), () => async args => {
      if (args[1] === "list") return page([changed]);
      if (args[1] === "history") return page([]);
      submitted++; throw new Error("Submission outcome unknown");
    });
    await assert.rejects(new StepRunner(nodes).execute(options, { type: "metric.task.submit", config, input: {} }), error => error.retryable === false);
    assert.equal(submitted, changed === task ? 1 : 0);
  }
});

test("metric polling tracks the new execution and extracts normalized dbt output", async () => {
  for (const [records, expected] of [
    [[record(100)], { state: "waiting", executionId: null }],
    [[record(101, "running")], { state: "waiting", executionId: 101 }],
    [[record(101, "close", { responseData: JSON.stringify({ data: { dbt: JSON.stringify({ output: "done" }) } }) })], { state: "completed", executionId: 101, output: "done" }],
  ]) {
    const nodes = registerMetricNodes(new NodeRegistry(), () => async () => page(records));
    assert.deepEqual(await new StepRunner(nodes).execute(options, { type: "metric.task.poll", config: pollConfig, input: pollInput }), expected);
  }
});

test("metric polling rejects ambiguous, failed, missing, oversized and expired results without automatic run retry", async () => {
  for (const [records, input, limit, pattern] of [
    [[record(101), record(102)], pollInput, 1000, /Multiple new/],
    [[record(101, "failed")], pollInput, 1000, /ended with status failed/],
    [[record(101, "success", { responseData: {} })], pollInput, 1000, /has no/],
    [[record(101)], pollInput, 1, /exceeds/],
    [[], { ...pollInput, executionId: 101 }, 1000, /disappeared/],
    [[], { ...pollInput, deadline: 0 }, 1000, /deadline exceeded/],
  ]) {
    const nodes = registerMetricNodes(new NodeRegistry(), () => async () => page(records));
    await assert.rejects(new StepRunner(nodes).execute(options, { type: "metric.task.poll", config: { ...pollConfig, maxOutputBytes: limit }, input }), error => error.retryable === false && pattern.test(error.message));
  }
});

test("funding workflow nodes execute through persistence and reuse successful submissions on replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-metric-"));
  const db = initializeDatabase(dir);
  try {
    const workflows = new WorkflowRepository(db);
    const saved = workflows.createWorkflow({ workspaceId: createDefaultWorkspace(db), name: "Metric fixture" });
    const version = createCodeVersion(workflows, { workflowId: saved.id, contentHash: "fixture", sourcePath: "source", bundlePath: "bundle", manifest: {}, sdkVersion: "0.1.0" });
    const run = new RunRepository(db).createRun({ workflowVersionId: version });
    let submissions = 0;
    const nodes = registerMetricNodes(new NodeRegistry(), () => async args => {
      if (args[1] === "list") return page([task]);
      if (args[1] === "run") { submissions++; return {}; }
      return page([record(submissions ? 101 : 100)]);
    });
    const workflow = defineWorkflow({ id: "fixture", name: "Fixture", inputSchema: {}, outputSchema: {}, async run(ctx) {
      const submission = await ctx.step.execute("submit-metric-task", { type: "metric.task.submit", config, input: {} });
      return await ctx.step.execute("poll-metric-task", { type: "metric.task.poll", config: pollConfig, input: { executionId: null, baseline: submission.baseline, deadline: submission.deadline } });
    } });
    const execution = new WorkflowExecutionService(db, nodes);
    for (let replay = 0; replay < 2; replay++) {
      assert.deepEqual(await execution.execute(run.id, workflow, {}, new AbortController().signal), { state: "completed", executionId: 101, output: "dbt completed" });
    }
    assert.equal(submissions, 1);
    const attempts = db.database.prepare("SELECT COUNT(*) AS count FROM step_attempts").get();
    assert.equal(attempts.count, 2);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("default metric adapter passes profile arguments, bounds read retries and keeps raw errors out of persisted messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-metric-cli-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}:${previousPath}`;
    const callsPath = join(dir, "calls.jsonl");
    for (const [script, count, pattern] of [
      ['console.error("private-credential"); process.exit(1);', 3, /metric-cli failed/],
      ['console.log("invalid JSON private-credential");', 1, /invalid JSON/],
    ]) {
      await writeFile(callsPath, "");
      await writeFile(join(dir, "metric-cli"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n"); ${script}\n`, { mode: 0o700 });
      await assert.rejects(new StepRunner(createLocalNodeRegistry()).execute(options, { type: "metric.task.poll", config: pollConfig, input: pollInput }), error => {
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes("private-credential"));
        return pattern.test(error.message);
      });
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, count);
      assert.deepEqual(calls[0], ["--profile", "pt", "--json", "task", "history", "--id", "73", "--page", "1", "--size", "100"]);
    }
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
