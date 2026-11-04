import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { executeProcess } from "../src/runtime/process.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { Store } from "../src/persistence/store.js";
import { setup, publishExample, until, temporary, exampleFiles } from "./helpers.js";

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
    assert.equal(snapshot.version.id, version.id);
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
