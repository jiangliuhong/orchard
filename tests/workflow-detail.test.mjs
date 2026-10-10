import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflowDetail, describeWorkflowSteps } from "../dist/server/workflow-detail.js";
import { createServer } from "../dist/server/app.js";
import { discoverWorkflows } from "../dist/authoring/discovery.js";

const workflow = { id: "fixture", workspaceId: "workspace", name: "Fixture", description: "Example", status: "active" };
const code = `// ctx.step.execute("comment", { type: "fake.node" });
const text = 'ctx.step.execute("string", {})';
await ctx.step.execute<Submission>("submit", { config: { type: "nested.type" }, type: "metric.task.submit", input: {} });
await ctx.step.execute<PollResult>(\`poll-\${attempt}\`, { type: "metric.task.poll", input: {} });
await ctx.step.sleep("wait", 10000);
throw new Error("source is only read, never executed");
export default async function run() {};`;
const version = { id: "version", workflowId: workflow.id, versionNo: 1, createdAt: 1, contentHash: createHash("sha256").update(code).digest("hex"), sourcePath: "source", manifest: { entry: "worker.ts", files: ["worker.ts", "README.md"] } };

test("step descriptions ignore comments and string literals, preserve dynamic IDs and use top-level request type", () => {
  const steps = describeWorkflowSteps({ path: "worker.ts", code });
  assert.deepEqual(steps.map(step => [step.id, step.type, step.line]), [["submit", "metric.task.submit", 3], ["poll-${attempt}", "metric.task.poll", 4], ["wait", "sleep", 5]]);
  assert.deepEqual(steps.map(step => step.description), ["", "", ""]);
});

test("workflow detail reads directory and legacy file sources and identifies modified published source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-source-"));
  try {
    await mkdir(join(dir, "source"));
    await writeFile(join(dir, "source/worker.ts"), code);
    await writeFile(join(dir, "source/README.md"), "Step documentation");
    for (const sourcePath of ["source", join(dir, "source/worker.ts")]) {
      const detail = await readWorkflowDetail(dir, workflow, { ...version, sourcePath });
      assert.equal(detail.files.length, 2);
      assert.equal(detail.files[0].code, code);
      assert.equal(detail.steps.length, 3);
      assert.equal(detail.workflow.description, undefined);
      assert.equal(detail.sourceWarning, undefined);
      assert.equal(JSON.stringify(detail).includes(dir), false);
    }
    await writeFile(join(dir, "source/worker.ts"), code + "\n// changed");
    assert.match((await readWorkflowDetail(dir, workflow, version)).sourceWarning, /已发生修改/);
    const unpublished = await readWorkflowDetail(dir, workflow);
    assert.equal(unpublished.version, null);
    assert.deepEqual(unpublished.files, []);
    assert.equal(unpublished.workflow.description, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("source reader refuses traversal and symlink escapes without exposing file content or absolute paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-source-boundary-"));
  try {
    await mkdir(join(dir, "source"));
    await writeFile(join(dir, "outside.ts"), "private content");
    await symlink(join(dir, "outside.ts"), join(dir, "source/worker.ts"));
    for (const manifest of [version.manifest, { entry: "../outside.ts" }]) {
      const detail = await readWorkflowDetail(dir, workflow, { ...version, manifest });
      assert.deepEqual(detail.files, []);
      assert.ok(detail.sourceWarning);
      assert.equal(JSON.stringify(detail).includes("private content"), false);
      assert.equal(JSON.stringify(detail).includes(dir), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workflow detail UI route and API handle direct visits, unknown workflows, storage errors and origin checks", async t => {
  const detail = await readWorkflowDetail("unused", workflow);
  const app = createServer({ getWorkflowDetail: async id => {
    if (id === "fixture") return detail;
    if (id === "error") throw new Error("private source path");
  } });
  t.after(() => app.close());
  const page = await app.inject({ url: "/workflows/fixture" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  const response = await app.inject({ url: "/api/workflows/fixture" });
  assert.deepEqual(response.json(), detail);
  assert.equal((await app.inject({ url: "/api/workflows/missing" })).statusCode, 404);
  const error = await app.inject({ url: "/api/workflows/error" });
  assert.equal(error.statusCode, 500);
  assert.ok(!error.body.includes("private source path"));
  assert.equal((await app.inject({ url: "/api/workflows/fixture", headers: { origin: "https://evil.example" } })).statusCode, 403);
});


test("step documentation comes from adjacent source comments or an explicit description", () => {
  const steps = describeWorkflowSteps({ path: "worker.ts", code: `
// 提交任务
// 保存本次提交的基线
const submission = await ctx.step.execute("submit", { type: "metric.task.submit", config: {}, input: {} });
/**
 * 查询执行历史。
 * 等待任务完成。
 */
await ctx.step.execute("poll", { type: "metric.task.poll", description: "源码明确说明\\n第二行", config: { description: "忽略嵌套说明" }, input: {} });
/** 等待任务重试 */
await ctx.step.sleep("wait", 100);
// 不属于下一个步骤

await ctx.step.sendEvent("done", {});
await ctx.step.run("dynamic", { type: "custom", description: computeDescription(), config: {}, input: {} });
// ctx.step.sleep("fake", 1);
const fake = /ctx.step.sleep("regex", 1)/;
` });
  assert.deepEqual(steps.map(step => step.description), ["提交任务\n保存本次提交的基线", "源码明确说明\n第二行", "等待任务重试", "", ""]);
  assert.equal(steps.length, 5);
});

test("block comments, escaped literals and nested calls retain their own source documentation", () => {
  const steps = describeWorkflowSteps({ path: "worker.ts", code: `
/**
 * 轮询任务。
 * 读取输出。
 * @returns 查询结果
 */
await ctx.step.run("poll", { type: "custom", config: {}, input: {} });
// 执行外层步骤
await ctx.step.run("outer", { type: "custom", config: {}, input: await ctx.step.run("inner", { type: "custom", config: {}, input: {} }) });
const description = "本地常量说明";
await ctx.step.execute("literal", { type: "custom", description, config: {}, input: {} });
` });
  assert.deepEqual(steps.map(step => step.description), ["轮询任务。\n读取输出。", "执行外层步骤", "", ""]);
});

test("workflow description is read from the exported definition, never database or nested descriptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-description-"));
  try {
    await mkdir(join(dir, "source"));
    await writeFile(join(dir, "source/README.md"), "Unrelated documentation");
    const sources = [
      ['export default defineWorkflow({ inputSchema: { description: "nested" }, description: `代码中的工作流说明`, run: async () => { throw new Error("never execute") } });', "代码中的工作流说明"],
      ['const text = "源码常量"; const workflow = defineWorkflow({ description: text }); export default workflow;', "源码常量"],
      ['export default defineWorkflow({ run: async () => { const description = "not workflow metadata"; } });', undefined],
      ['export default defineWorkflow({ description: externalValue() });', undefined],
      ['/** 源码入口说明 */\nexport default async function run() { throw new Error("never execute"); }', "源码入口说明"],
    ];
    for (const [source, expected] of sources) {
      await writeFile(join(dir, "source/worker.ts"), source);
      const detail = await readWorkflowDetail(dir, workflow, { ...version, contentHash: "" });
      assert.equal(detail.workflow.description, expected);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workflow list uses source descriptions and never falls back to stored descriptions", async t => {
  const app = createServer({
    listWorkflows: () => [workflow, { ...workflow, id: "missing" }],
    getWorkflowDetail: async id => id === "fixture" ? { workflow: { ...workflow, description: "源码描述" }, version: null, entry: null, files: [], steps: [] } : undefined,
  });
  t.after(() => app.close());
  const response = await app.inject({ url: "/api/workflows" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().items.map(item => item.description), ["源码描述", undefined]);
});


test("local discovery reads exported workflow metadata without confusing step descriptions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-discovery-description-"));
  try {
    const root = join(dir, "default/workflows/report");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "worker.ts"), `
// description: "忽略注释里的字段"
const nested = { description: "忽略其他对象" };
export default defineWorkflow({
  id: "report", name: "报告", description: \`源码描述\`,
  async run(ctx) { await ctx.step.execute("submit", { type: "custom", description: "步骤描述" }); }
});`);
    const [item] = await discoverWorkflows(dir);
    assert.equal(item.id, "report");
    assert.equal(item.name, "报告");
    assert.equal(item.description, "源码描述");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
