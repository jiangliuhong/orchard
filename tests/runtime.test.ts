import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { executeProcess } from "../src/runtime/process.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { Store } from "../src/persistence/store.js";
import { setup, publishExample, until, temporary, exampleFiles } from "./helpers.js";
import { validateWorkflow } from "../src/domain/validation.js";
import { json } from "../src/persistence/files.js";
import type { Workflow } from "../src/domain/types.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";

test("script workflow nodes run immutable versions and enforce their contract", async t => {
  const { store, providers } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const definition = (version: string, timeoutMs = 300000): ScriptDefinition => ({ id: "normalize", name: "Normalize", description: "", runtime: "nodejs", entryFile: "index.js", timeoutMs, inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["value", "version"], properties: { value: { type: "string" }, version: { type: "string" } }, additionalProperties: false }, files: { "index.js": `export default input => ({ value: input.value.toUpperCase(), version: ${JSON.stringify(version)} });` } });
  const first = definition("one"), firstTree = store.files.saveScriptTree(first.files), firstCreated = store.createScript(first, firstTree.path, firstTree.hash), firstPublished = store.publishScript(first.id, firstCreated.version.revision).version;
  const workflow: Workflow = { formatVersion: 1, id: "uses-normalize", name: "Uses normalize", inputSchema: { type: "object" }, outputSchema: first.outputSchema, entryNodeId: "normalize", nodes: [{ id: "normalize", name: "Normalize", type: "script", input: { source: "workflow" }, outputSchema: first.outputSchema, config: { scriptId: first.id, scriptVersionId: firstPublished.id } }], edges: [], result: { source: "node", nodeId: "normalize" } };
  validateWorkflow(workflow);
  const tree = store.files.saveTree({ "workflow.json": JSON.stringify(workflow), "layout.json": "{}" });
  store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", workflow.id, workflow.name, Date.now(), Date.now());
  const workflowVersionId = randomUUID(); store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", workflowVersionId, workflow.id, 1, json(workflow), "{}", tree.path, tree.hash, Date.now()); store.exec("UPDATE workflows SET current_version_id=? WHERE id=?", workflowVersionId, workflow.id);
  const run = runner.create(workflowVersionId, { value: "hello" }, randomUUID());
  await until(() => { const current = store.run(run.id); return ["succeeded", "failed"].includes(current.status) && current; });
  assert.deepEqual(store.run(run.id).output, { value: "HELLO", version: "one" });
  const second = definition("two"), secondTree = store.files.saveScriptTree(second.files); const draft = store.updateScriptDraft(first.id, 0, second, secondTree.path, secondTree.hash); const secondPublished = store.publishScript(first.id, draft.version.revision).version;
  assert.equal(store.scriptVersion(firstPublished.id).contentHash, firstPublished.contentHash);
  const oldRun = runner.create(workflowVersionId, { value: "world" }, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(oldRun.id).status)); assert.deepEqual(store.run(oldRun.id).output, { value: "WORLD", version: "one" });
  store.archiveScript(first.id); const archivedRun = runner.create(workflowVersionId, { value: "archived" }, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(archivedRun.id).status)); assert.deepEqual(store.run(archivedRun.id).output, { value: "ARCHIVED", version: "one" });
  assert.notEqual(secondPublished.id, firstPublished.id);
  assert.throws(() => store.assertWorkflowScripts({ ...workflow, nodes: [{ ...workflow.nodes[0]!, config: { scriptId: first.id, scriptVersionId: secondPublished.id } }] }), /已发布|版本/);
});

test("Shell script workflow nodes preserve the bounded output protocol", async t => {
  const { store, providers } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const definition: ScriptDefinition = { id: "shell-transform", name: "Shell transform", description: "", runtime: "shell", entryFile: "run.sh", inputSchema: { type: "object" }, outputSchema: { type: "object" }, files: { "run.sh": "#!/bin/bash\nread -r input\nprintf '{\\\"input\\\":%s}' \"$input\"\n" } };
  const tree = store.files.saveScriptTree(definition.files), created = store.createScript(definition, tree.path, tree.hash), version = store.publishScript(definition.id, created.version.revision).version;
  const workflow: Workflow = { formatVersion: 1, id: "uses-shell-library", name: "Uses shell", inputSchema: { type: "object" }, outputSchema: { type: "object" }, entryNodeId: "run", nodes: [{ id: "run", name: "Run shell", type: "script", input: { source: "workflow" }, outputSchema: { type: "object" }, config: { scriptId: definition.id, scriptVersionId: version.id } }], edges: [], result: { source: "node", nodeId: "run" } };
  const artifact = store.files.saveTree({ "workflow.json": JSON.stringify(workflow), "layout.json": "{}" }), workflowVersionId = randomUUID();
  store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", workflow.id, workflow.name, Date.now(), Date.now()); store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", workflowVersionId, workflow.id, 1, json(workflow), "{}", artifact.path, artifact.hash, Date.now());
  const run = runner.create(workflowVersionId, { ok: true }, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(run.id).status));
  assert.equal(store.run(run.id).status, "succeeded", JSON.stringify(store.run(run.id).error)); assert.deepEqual(store.run(run.id).output, { stdout: "{\"input\":{\"ok\":true}}", stderr: "", exitCode: 0 });
});

test("script workflow nodes propagate input/output schema failures, timeout and tampering", async t => {
  const { store, providers } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const makeVersion = (definition: ScriptDefinition) => { const tree = store.files.saveScriptTree(definition.files), created = store.createScript(definition, tree.path, tree.hash); return { version: store.publishScript(definition.id, created.version.revision).version, tree }; };
  const invalidInput = makeVersion({ id: "requires-value", name: "Requires value", description: "", runtime: "nodejs", entryFile: "index.js", inputSchema: { type: "object", required: ["value"], properties: { value: { type: "string" } } }, outputSchema: true, files: { "index.js": "export default input => input" } });
  const invalidOutput = makeVersion({ id: "returns-number", name: "Returns number", description: "", runtime: "nodejs", entryFile: "index.js", inputSchema: true, outputSchema: { type: "string" }, files: { "index.js": "export default () => 42" } });
  const slow = makeVersion({ id: "slow-script", name: "Slow", description: "", runtime: "nodejs", entryFile: "index.js", timeoutMs: 1000, inputSchema: true, outputSchema: true, files: { "index.js": "export default async () => { await new Promise(resolve => setTimeout(resolve, 5000)); return true; }" } });
  const makeWorkflow = (id: string, scriptId: string, version: string): string => { const workflow: Workflow = { formatVersion: 1, id, name: id, inputSchema: { type: "object" }, outputSchema: true, entryNodeId: "run", nodes: [{ id: "run", name: id, type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId, scriptVersionId: version } }], edges: [], result: { source: "node", nodeId: "run" } }; const artifact = store.files.saveTree({ "workflow.json": JSON.stringify(workflow), "layout.json": "{}" }), workflowVersionId = randomUUID(); store.exec("INSERT INTO workflows VALUES(?,?,NULL,?,?)", workflow.id, workflow.name, Date.now(), Date.now()); store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", workflowVersionId, workflow.id, 1, json(workflow), "{}", artifact.path, artifact.hash, Date.now()); return workflowVersionId; };
  const inputWorkflow = makeWorkflow("workflow-requires-value", "requires-value", invalidInput.version.id);
  const inputRun = runner.create(inputWorkflow, {}, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(inputRun.id).status)); assert.equal(store.run(inputRun.id).status, "failed"); assert.equal(store.run(inputRun.id).error?.code, "SCHEMA_MISMATCH");
  const outputWorkflow = makeWorkflow("workflow-returns-number", "returns-number", invalidOutput.version.id); const outputRun = runner.create(outputWorkflow, {}, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(outputRun.id).status)); assert.equal(store.run(outputRun.id).error?.code, "SCHEMA_MISMATCH");
  const slowWorkflow = makeWorkflow("workflow-slow-script", "slow-script", slow.version.id); const slowRun = runner.create(slowWorkflow, {}, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(slowRun.id).status), 4000); assert.equal(store.run(slowRun.id).error?.code, "TIMEOUT");
  writeFileSync(store.files.path(slow.tree.path), "tampered"); const tamperedRun = runner.create(slowWorkflow, {}, randomUUID()); await until(() => ["succeeded", "failed"].includes(store.run(tamperedRun.id).status)); assert.equal(store.run(tamperedRun.id).error?.code, "ARTIFACT_MISMATCH");
});

test("same published version runs two paths and retains node results and metadata", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const version = await publishExample(authoring);
  providers.update(provider.id, { defaultModel: "new-default" });
  for (const action of ["execute", "skip", "unexpected"]) {
    const run = runner.create(version.id, { action }, randomUUID());
    const done = await until(() => { const r = store.run(run.id); return ["succeeded", "failed"].includes(r.status) && r; });
    assert.equal(done.status, "succeeded", JSON.stringify(done.error));
    assert.equal((done.output as { action: string }).action, action);
    const snapshot = runner.snapshot(run.id);
    assert.equal(snapshot.nodes.find(n => n.nodeId === "c")!.status, action === "execute" ? "succeeded" : "skipped");
    assert.equal(snapshot.nodes.find(n => n.nodeId === "route")!.route?.edgeId, action === "unexpected" ? "other" : action === "execute" ? "do" : "skip");
    assert.ok(snapshot.attempts.length >= 3);
    assert.equal(snapshot.version?.id, version.id);
    assert.ok(store.stream("run", run.id).some(e => e.type === "node.log"));
  }
  assert.ok(provider.calls.every(call => call.modelId === "test-model"));
});
test("Agent invalid output fails before Switch and disabled providers do not fall back", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const version = await publishExample(authoring);
  provider.handler = async r => ({ output: { action: 7 }, modelId: r.modelId, providerId: provider.id });
  const run = runner.create(version.id, { action: "execute" }, randomUUID());
  await until(() => store.run(run.id).status === "failed");
  assert.equal(store.nodes(run.id).find(n => n.nodeId === "b")!.status, "failed");
  assert.equal(store.nodes(run.id).find(n => n.nodeId === "route")!.status, "skipped");
  providers.update(provider.id, { enabled: false });
  assert.throws(() => runner.create(version.id, {}, randomUUID()), /禁用/);
});
test("active cancellation wins over late Agent success and queued cancellation never starts", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const version = await publishExample(authoring);
  let release!: () => void;
  provider.handler = async r => { await new Promise<void>(resolve => { release = resolve; }); return { output: { action: "execute" }, providerId: provider.id, modelId: r.modelId }; };
  const run = runner.create(version.id, {}, randomUUID());
  await until(() => typeof release === "function");
  const queued = runner.create(version.id, {}, randomUUID());
  runner.cancel(queued.id); assert.equal(store.run(queued.id).status, "cancelled");
  runner.cancel(run.id); release();
  await until(() => store.run(run.id).status === "cancelled");
  assert.equal(store.nodes(run.id).find(n => n.nodeId === "c")!.skipReason, "run_terminated");
  assert.equal(provider.calls.length, 1);
});
test("Node process control terminates CPU work and distinguishes timeout and output limits", async t => {
  const cwd = temporary(t), controller = new AbortController();
  const pending = executeProcess({ executable: process.execPath, args: ["-e", "while(true){}"], cwd, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { code: "CANCELLED" });
  await assert.rejects(executeProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd, timeoutMs: 20 }), { code: "TIMEOUT" });
  await assert.rejects(executeProcess({ executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000))"], cwd, maxBytes: 100 }), { code: "OUTPUT_LIMIT" });
});
test("cancellation kills descendants even when the parent exits before the grace timer", { timeout: 5000 }, async t => {
  const cwd = temporary(t), controller = new AbortController();
  let descendant: number | undefined;
  t.after(() => { if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* Already gone. */ } } });
  const childSource = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)";
  const parentSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const pending = executeProcess({ executable: process.execPath, args: ["-e", parentSource], cwd, signal: controller.signal, onLog: (stream, text) => {
    if (stream === "stdout" && /^\d+/.test(text)) { descendant = Number(text.trim()); controller.abort(); }
  } });
  await assert.rejects(pending, { code: "CANCELLED" });
  await until(() => { try { process.kill(descendant!, 0); return false; } catch { return true; } }, 2000);
});
test("restart marks active runs interrupted without repeating scripts", async t => {
  const { root, store, authoring } = setup(t), version = await publishExample(authoring);
  const id = randomUUID(), nodeId = randomUUID();
  store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES(?,?,'running',?,?)", id, version.id, store.reference({}), Date.now());
  store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,'a','code.nodejs','running')", nodeId, id);
  store.exec("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,started_at) VALUES(?,?,1,'running','{}',?)", randomUUID(), nodeId, Date.now());
  store.close();
  const recovered = new Store(root); t.after(() => recovered.close());
  assert.equal(recovered.run(id).status, "interrupted");
  assert.equal(recovered.nodes(id)[0]!.status, "interrupted");
  assert.equal(recovered.attempts(id)[0]!.status, "interrupted");
  assert.equal(recovered.stream("run", id).at(-1)!.type, "run.interrupted");
});
test("a shared successor executes once and Shell JSON results keep logs separate", async t => {
  const { store, providers, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), id = JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id;
  const files = exampleFiles(id), graph = JSON.parse(files["workflow.json"]!);
  graph.nodes.push({ id: "end", name: "Shared successor", type: "code.nodejs", input: { source: "node", nodeId: "b" }, outputSchema: true, config: { script: "scripts/end.js" } });
  graph.edges.push({ id: "c-end", from: "c", to: "end" });
  graph.edges.filter((e: { to: string | null }) => e.to === null).forEach((e: { to: string }) => { e.to = "end"; });
  graph.nodes.find((n: { id: string }) => n.id === "c").config.resultMode = "json";
  graph.result = { source: "node", nodeId: "end" };
  files["workflow.json"] = JSON.stringify(graph);
  files["scripts/end.js"] = "export default input => ({...input, completed:true})";
  files["scripts/c.sh"] = "read -r input\nprintf 'shell log\\n'\nprintf '{\"processed\":true}' > \"$ORCHARD_RESULT_FILE\"\n";
  const updated = await authoring.update(draft.id, 0, files), version = await authoring.publish(draft.id, updated.revision, randomUUID());
  for (const action of ["execute", "skip"]) {
    const run = runner.create(version.id, { action }, randomUUID());
    await until(() => ["succeeded", "failed"].includes(store.run(run.id).status));
    assert.equal(store.run(run.id).status, "succeeded", JSON.stringify(store.run(run.id).error));
    assert.equal(store.nodes(run.id).find(n => n.nodeId === "end")!.status, "succeeded");
    if (action === "execute") assert.deepEqual(store.nodes(run.id).find(n => n.nodeId === "c")!.output, { processed: true });
  }
});
test("Shell nonzero exit cannot succeed from a result file and no retry occurs", async t => {
  const { store, providers, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files;
  const graph = JSON.parse(files["workflow.json"]!);
  graph.nodes[0].type = "shell"; graph.nodes[0].config = { script: "scripts/fail.sh", resultMode: "json" };
  files["workflow.json"] = JSON.stringify(graph);
  files["scripts/fail.sh"] = "echo log\necho '{}' > \"$ORCHARD_RESULT_FILE\"\necho 'failed side effect' >&2\nexit 3";
  const updated = await authoring.update(draft.id, 0, files), version = await authoring.publish(draft.id, updated.revision, randomUUID());
  const run = runner.create(version.id, {}, randomUUID()); await until(() => store.run(run.id).status === "failed");
  assert.equal(store.nodes(run.id)[0]!.error!.code, "PROCESS_FAILED"); assert.equal(store.attempts(run.id).length, 1);
  assert.ok(store.stream("run", run.id).some(e => e.type === "node.process"));
});

test("unpublished drafts run immutable snapshots without creating published workflows or versions", async t => {
  const { store, providers, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID());
  const key = randomUUID(), input = { example: "original" };
  const run = await runner.createDraft(draft.id, 0, input, key);
  const originalPath = run.snapshotPath;
  assert.equal(run.workflowVersionId, null);
  assert.equal(run.draftId, draft.id);
  assert.equal(run.draftRevision, 0);
  const files = authoring.snapshot(draft.id).files;
  await authoring.update(draft.id, 0, { ...files, "scripts/start.ts": "export default () => ({changed:true})" });
  assert.equal((await runner.createDraft(draft.id, 0, input, key)).id, run.id);
  await assert.rejects(runner.createDraft(draft.id, 0, { different: true }, key), /不同内容/);
  const done = await until(() => { const current = store.run(run.id); return ["succeeded", "failed"].includes(current.status) && current; });
  assert.equal(done.status, "succeeded", JSON.stringify(done.error));
  assert.deepEqual(done.output, input);
  const snapshot = runner.snapshot(run.id);
  assert.equal(snapshot.version, null);
  assert.equal(snapshot.execution.artifactPath, originalPath);
  assert.equal(snapshot.nodes[0]!.status, "succeeded");
  assert.ok(snapshot.attempts.length);
  assert.equal(store.draft(draft.id).status, "draft");
  assert.equal(store.draft(draft.id).revision, 1);
  assert.equal(store.workflows().length, 0);
  assert.equal(store.all("SELECT id FROM workflow_versions").length, 0);
  const second = await runner.createDraft(draft.id, 1, input, randomUUID());
  await until(() => store.run(second.id).status === "succeeded");
  assert.deepEqual(store.run(second.id).output, { changed: true });
  assert.notEqual(second.snapshotPath, originalPath);
});

test("draft tests reject stale revisions, invalid input, invalid scripts, active authoring and published drafts", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files;
  const workflow = JSON.parse(files["workflow.json"]!);
  workflow.inputSchema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
  await authoring.update(draft.id, 0, { ...files, "workflow.json": JSON.stringify(workflow) });
  await assert.rejects(runner.createDraft(draft.id, 0, { name: "test" }, randomUUID()), /草稿已更新/);
  await assert.rejects(runner.createDraft(draft.id, 1, {}, randomUUID()), /工作流输入/);
  const saved = authoring.snapshot(draft.id).files;
  await authoring.update(draft.id, 1, { ...saved, "scripts/start.ts": "not valid typescript !!!" });
  await assert.rejects(runner.createDraft(draft.id, 2, { name: "test" }, randomUUID()), /校验/);
  await authoring.update(draft.id, 2, saved);
  let release!: () => void;
  provider.handler = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return { output: { summary: "unchanged", changes: [] }, providerId: provider.id, modelId: request.modelId };
  };
  const turn = await authoring.start(draft.id, { providerId: provider.id, modelId: "test-model", prompt: "review", expectedRevision: 3, requestId: randomUUID() });
  await until(() => typeof release === "function");
  await assert.rejects(runner.createDraft(draft.id, 3, { name: "test" }, randomUUID()), /正在生成/);
  release(); await authoring.wait(turn.id);
  await authoring.publish(draft.id, 3, randomUUID());
  await assert.rejects(runner.createDraft(draft.id, 3, { name: "test" }, randomUUID()), /已经发布/);
  assert.equal(store.runs().length, 0);
});

test("draft tests freeze Agent models, reject revisions changed during preparation and support cancellation", async t => {
  const { store, providers, provider, authoring } = setup(t), runner = new GraphRunner(store, providers);
  t.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), workflowId = JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id;
  await authoring.update(draft.id, 0, exampleFiles(workflowId));
  let release!: () => void;
  provider.handler = async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return { output: { action: "skip" }, providerId: provider.id, modelId: request.modelId };
  };
  const run = await runner.createDraft(draft.id, 1, {}, randomUUID());
  const frozen = runner.snapshot(run.id);
  assert.equal(frozen.execution.definition.defaults?.agent?.agentConfigId, "test-agent-config");
  assert.equal(frozen.agentBindings.find(binding => binding.nodeId === "b")!.modelId, "test-model");
  await until(() => typeof release === "function");
  const queued = await runner.createDraft(draft.id, 1, {}, randomUUID());
  runner.cancel(queued.id);
  assert.equal(store.run(queued.id).status, "cancelled");
  runner.cancel(run.id); release();
  await until(() => store.run(run.id).status === "cancelled");
  assert.equal(store.nodes(run.id).find(node => node.nodeId === "c")!.skipReason, "run_terminated");
  const saveTree = store.files.saveTree.bind(store.files);
  store.files.saveTree = (...args: Parameters<typeof saveTree>) => {
    const result = saveTree(...args);
    store.exec("UPDATE drafts SET revision=revision+1 WHERE id=?", draft.id);
    return result;
  };
  await assert.rejects(runner.createDraft(draft.id, 1, {}, randomUUID()), /草稿已更新/);
  assert.equal(store.runs().length, 2);
});

test("restart resumes queued draft snapshots and interrupts active tests without repeating them", async t => {
  const { root, store, authoring, provider } = setup(t);
  const draft = await authoring.create(undefined, randomUUID());
  const files = authoring.snapshot(draft.id).files;
  const { compileScripts, readDefinition } = await import("../src/persistence/files.js");
  const tree = store.files.saveTree(files, await compileScripts(files, readDefinition(files)));
  for (const status of ["running", "queued"]) {
    const id = `draft-${status}`;
    store.exec("INSERT INTO runs(id,draft_id,draft_revision,snapshot_path,status,input_ref,created_at) VALUES(?,?,0,?,?,?,?)", id, draft.id, tree.path, status, store.reference({ restored: true }), Date.now());
    store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,'start','code.nodejs',?)", `node-${status}`, id, status === "running" ? "running" : "pending");
    if (status === "running") store.exec("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,started_at) VALUES('draft-attempt',?,1,'running','{}',?)", `node-${status}`, Date.now());
  }
  store.close();
  const recovered = new Store(root);
  const { ProviderRegistry } = await import("../src/providers/registry.js");
  const runner = new GraphRunner(recovered, new ProviderRegistry(recovered).register(provider, process.execPath));
  t.after(async () => { await runner.close(); recovered.close(); });
  assert.equal(recovered.run("draft-running").status, "interrupted");
  assert.equal(recovered.nodes("draft-running")[0]!.status, "interrupted");
  assert.equal(recovered.attempts("draft-running")[0]!.status, "interrupted");
  await until(() => recovered.run("draft-queued").status === "succeeded");
  assert.deepEqual(recovered.run("draft-queued").output, { restored: true });
  assert.equal(runner.snapshot("draft-queued").version, null);
  assert.equal(recovered.workflows().length, 0);
});

test("configured final output extracts text and composes fields independently of node outputs", async context => {
  const { store, providers, authoring } = setup(context), runner = new GraphRunner(store, providers);
  context.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files;
  const definition = JSON.parse(files["workflow.json"]!);
  definition.result = { source: "node", nodeId: "start", pointer: "/summary" };
  definition.outputSchema = { type: "string" };
  files["workflow.json"] = JSON.stringify(definition);
  files["scripts/start.ts"] = 'export default input => ({summary: "最终正文", metadata: input})';
  await authoring.update(draft.id, 0, files);
  const test = await runner.createDraft(draft.id, 1, { query: "土豆" }, randomUUID());
  await until(() => ["succeeded", "failed"].includes(store.run(test.id).status));
  assert.equal(store.run(test.id).status, "succeeded");
  assert.equal(store.run(test.id).output, "最终正文");
  assert.deepEqual(store.nodes(test.id)[0]!.output, { summary: "最终正文", metadata: { query: "土豆" } });
  const version = await authoring.publish(draft.id, 1, randomUUID());
  const edit = await authoring.editVersion(version.workflowId, undefined, "edit", randomUUID());
  definition.result = { source: "object", properties: { summary: { source: "node", nodeId: "start", pointer: "/summary" }, query: { source: "workflow", pointer: "/query" } } };
  definition.outputSchema = { type: "object", required: ["summary", "query"], properties: { summary: { type: "string" }, query: { type: "string" } } };
  files["workflow.json"] = JSON.stringify(definition);
  await authoring.update(edit.id, 0, files);
  const composed = await runner.createDraft(edit.id, 1, { query: "土豆" }, randomUUID());
  await until(() => ["succeeded", "failed"].includes(store.run(composed.id).status));
  assert.equal(store.run(composed.id).status, "succeeded");
  assert.deepEqual(store.run(composed.id).output, { summary: "最终正文", query: "土豆" });
  assert.equal(store.run(test.id).output, "最终正文");
  assert.equal(store.version(version.id).definition.result.source, "node");
});

test("final output schema and missing fields can fail a run after all nodes succeed", async context => {
  const { store, providers, authoring } = setup(context), runner = new GraphRunner(store, providers);
  context.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files;
  const definition = JSON.parse(files["workflow.json"]!);
  for (const [index, pointer, schema, error] of [[0, "/missing", true, "MISSING_INPUT"], [1, "", { type: "string" }, "SCHEMA_MISMATCH"]] as const) {
    definition.result = { source: "node", nodeId: "start", pointer };
    definition.outputSchema = schema;
    files["workflow.json"] = JSON.stringify(definition);
    await authoring.update(draft.id, index, files);
    const run = await runner.createDraft(draft.id, index + 1, { value: 1 }, randomUUID());
    await until(() => store.run(run.id).status === "failed");
    assert.equal(store.run(run.id).error!.code, error);
    assert.equal(store.run(run.id).output, undefined);
    assert.equal(store.nodes(run.id)[0]!.status, "succeeded");
  }
});
