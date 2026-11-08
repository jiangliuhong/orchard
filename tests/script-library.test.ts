import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { digest } from "../src/persistence/files.js";
import { createApp } from "../src/server/app.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { ScriptAgentService } from "../src/authoring/script-agent.js";
import { ScriptJournal } from "../src/persistence/script-journal.js";
import { ScriptMaintenance } from "../src/persistence/script-maintenance.js";
import { ScriptTestRunner } from "../src/runtime/script-tests.js";
import { executeScript } from "../src/runtime/script.js";
import { GraphRunner } from "../src/runtime/runner.js";
import { prepareScriptProposal } from "../src/domain/script-authoring.js";
import { schemaSubset, bindingSchema } from "../src/domain/schema-compatibility.js";
import type { ScriptDefinition } from "../src/domain/scripts.js";
import { setup, until } from "./helpers.js";

const definition = (id = "library-script"): ScriptDefinition => ({
  id, name: "Original name", description: "Original description", runtime: "nodejs", entryFile: "main.ts",
  inputSchema: true, outputSchema: true, files: { "main.ts": "export default () => ({version: 'original'})" },
});
const proposal = () => ({ summary: "更新脚本并生成测试输入", changes: [{ operation: "update", path: "main.ts", content: "export default input => ({ changed: input })" }], metadata: { name: "Agent name" }, testInput: { hello: true } });

test("script manifests snapshot metadata and create/update/restore commands are idempotent", async context => {
  const { store } = setup(context), library = new ScriptLibrary(store); context.after(() => store.close());
  const input = { ...definition(), requestId: randomUUID() }, created = await library.create(input);
  assert.equal((await library.create(input)).version.id, created.version.id);
  await assert.rejects(library.create({ ...input, name: "conflict" }), { code: "REQUEST_CONFLICT" });
  const published = store.publishScript(input.id, 0);
  const update = { ...definition(), name: "Next name", description: "Next description", expectedRevision: 0, expectedDraftVersionId: null, requestId: randomUUID() };
  const newer = await library.update(input.id, update);
  assert.equal((await library.update(input.id, update)).version.revision, 1);
  assert.equal(library.version(input.id, published.version.id).name, "Original name");
  assert.equal(library.version(input.id, published.version.id).description, "Original description");
  assert.equal(library.version(input.id, newer.version.id).name, "Next name");
  await assert.rejects(library.restore(input.id, { versionId: published.version.id, expectedRevision: 1, expectedDraftVersionId: newer.version.id, replaceDraft: false, requestId: randomUUID() }), { code: "DRAFT_EXISTS" });
  const restoreInput = { versionId: published.version.id, expectedRevision: 1, expectedDraftVersionId: newer.version.id, replaceDraft: true, requestId: randomUUID() };
  const restored = await library.restore(input.id, restoreInput);
  assert.equal(restored.version.revision, 2);
  assert.equal((await library.restore(input.id, restoreInput)).version.revision, 2);
  assert.equal(library.version(input.id, restored.version.id).name, "Original name");
});

test("queued script tests use their immutable snapshot after editing and publishing", async context => {
  const { store } = setup(context), library = new ScriptLibrary(store); context.after(() => store.close());
  const created = await library.create(definition());
  const queued = store.createScriptTest(created.script.id, null, 0, { input: true });
  await library.update(created.script.id, { ...definition(), expectedRevision: 0, files: { "main.ts": "export default () => ({version:'newer'})" } });
  store.publishScript(created.script.id, 1);
  const runner = new ScriptTestRunner(store); context.after(() => runner.close()); runner.enqueue(queued.id);
  await until(() => store.scriptTest(queued.id).status === "succeeded");
  assert.deepEqual(store.scriptTest(queued.id).output, { version: "original" });
  assert.deepEqual(store.scriptTest(queued.id).input, { input: true });
  assert.equal(store.scriptTest(queued.id).draftRevision, 0);
});

test("Shell JSON output is explicit, separated from logs, and temporary files and secrets are isolated", async context => {
  const { store } = setup(context); context.after(() => store.close());
  const cwd = store.files.path("runs");
  const shell = { runtime: "shell" as const, entryFile: "main.sh", files: { "main.sh": "echo log; printf '{\"ok\":true}' > \"$ORCHARD_RESULT_FILE\"" }, input: {}, cwd };
  const json = await executeScript({ ...shell, resultMode: "json" });
  assert.deepEqual(json.output, { ok: true }); assert.equal(json.stdout, "log\n");
  const process = await executeScript({ ...shell, resultMode: "process" });
  assert.deepEqual(process.output, { stdout: "log\n", stderr: "", exitCode: 0 });
  await assert.rejects(executeScript({ ...shell, resultMode: "json", files: { "main.sh": "echo '{}'; exit 1" } }), { code: "PROCESS_FAILED" });
  assert.deepEqual(readdirSync(cwd), []);
  const previous = globalThis.process.env.ORCHARD_TEST_SECRET;
  globalThis.process.env.ORCHARD_TEST_SECRET = "should-never-inherit";
  try {
    const node = await executeScript({ ...definition(), input: {}, cwd, files: { "main.ts": "export default () => ({secret: process.env.ORCHARD_TEST_SECRET ?? null})" } });
    assert.deepEqual(node.output, { secret: null });
  } finally {
    if (previous === undefined) delete globalThis.process.env.ORCHARD_TEST_SECRET; else globalThis.process.env.ORCHARD_TEST_SECRET = previous;
  }
});

test("Agent changes reject traversal, duplicate operations, identity fields and missing entry before applying", () => {
  for (const changes of [
    [{ operation: "update", path: "../main.ts", content: "x" }],
    [{ operation: "update", path: "main.ts", content: "x" }, { operation: "delete", path: "main.ts" }],
    [{ operation: "delete", path: "main.ts" }],
    [{ operation: "create", path: "main.ts", content: "x" }],
  ]) assert.throws(() => prepareScriptProposal(definition(), { ...proposal(), changes }));
  assert.throws(() => prepareScriptProposal(definition(), { ...proposal(), metadata: { id: "other" } }));
  assert.equal(prepareScriptProposal(definition(), proposal()).definition.name, "Agent name");
  assert.equal(definition().files["main.ts"], "export default () => ({version: 'original'})");
});

test("script Agent previews without mutations, checks ownership, and confirms once per revision", async context => {
  const { store, providers, provider } = setup(context), { app, scripts, scriptAgent } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  await scripts.create(definition());
  await scripts.create({ ...definition("private-script"), files: { "main.ts": "export default () => 'PRIVATE_SOURCE_MARKER'" } });
  provider.handler = async request => {
    assert.ok(!request.prompt.includes("PRIVATE_SOURCE_MARKER"));
    assert.ok(request.prompt.includes("Never execute scripts"));
    return { output: proposal(), providerId: provider.id, modelId: request.modelId };
  };
  const payload = { providerId: provider.id, modelId: "test-model", prompt: "更新脚本", expectedRevision: 0, requestId: randomUUID() };
  const first = await app.inject({ method: "POST", url: "/api/scripts/library-script/agent/turns", payload });
  assert.equal(first.statusCode, 202, first.body);
  const turnId = first.json().id;
  assert.equal((await app.inject({ method: "POST", url: "/api/scripts/library-script/agent/turns", payload })).json().id, turnId);
  await until(() => scriptAgent.get("library-script", turnId).status === "succeeded");
  assert.equal(store.scriptVersion(store.script("library-script").currentDraftVersionId!).revision, 0);
  assert.deepEqual(scripts.detail("library-script").draft!.files, definition().files);
  assert.equal((await app.inject({ url: `/api/scripts/private-script/agent/turns/${turnId}` })).statusCode, 404);
  const apply = { turnId, expectedRevision: 0, requestId: randomUUID() };
  const result = await app.inject({ method: "POST", url: "/api/scripts/library-script/agent/apply", payload: apply });
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().version.revision, 1);
  assert.equal((await app.inject({ method: "POST", url: "/api/scripts/library-script/agent/apply", payload: apply })).json().version.revision, 1);
  assert.equal(scriptAgent.get("library-script", turnId).appliedRevision, 1);
  assert.equal(store.script("library-script").currentPublishedVersionId, null);
  assert.equal(scripts.detail("library-script").draft!.name, "Agent name");
  assert.equal(Object.hasOwn(scriptAgent.list("library-script").items[0]!, "proposal"), false);
  assert.equal(scriptAgent.list("library-script").items[0]!.hasChanges, true);
  assert.equal(scriptAgent.list("library-script").items[0]!.hasTestInput, true);
  const historicalConversation = scriptAgent.get("library-script", turnId).conversationId;
  store.publishScript("library-script", 1);
  await scripts.update("library-script", { ...definition(), expectedRevision: 0 });
  assert.throws(() => scriptAgent.start("library-script", { ...payload, expectedRevision: 1, conversationId: historicalConversation, requestId: randomUUID() }), { code: "CONVERSATION_DRAFT_CONFLICT" });
});

test("script Agent groups and filters conversations and persists archival without deleting turns", async context => {
  const { store, providers, provider } = setup(context), { app, scripts, scriptAgent } = createApp(store, providers);
  context.after(() => app.close());
  await app.ready();
  await scripts.create(definition());
  provider.handler = async request => ({ output: proposal(), providerId: provider.id, modelId: request.modelId });
  const input = { providerId: provider.id, modelId: "test-model", prompt: "第一轮", expectedRevision: 0, requestId: randomUUID(), conversationId: randomUUID() };
  const first = scriptAgent.start("library-script", input);
  await until(() => scriptAgent.get("library-script", first.id).status === "succeeded");
  const second = scriptAgent.start("library-script", { ...input, prompt: "继续修改", requestId: randomUUID() });
  await until(() => scriptAgent.get("library-script", second.id).status === "succeeded");
  const other = scriptAgent.start("library-script", { ...input, conversationId: randomUUID(), requestId: randomUUID() });
  await until(() => scriptAgent.get("library-script", other.id).status === "succeeded");
  const groups = await app.inject({ url: "/api/scripts/library-script/agent/conversations" });
  assert.equal(groups.json().items.length, 2);
  assert.equal(groups.json().items.find((item: { id: string }) => item.id === input.conversationId).title, "第一轮");
  const filtered = await app.inject({ url: `/api/scripts/library-script/agent/turns?conversationId=${input.conversationId}&limit=1` });
  assert.equal(filtered.json().total, 2);
  assert.equal(filtered.json().items.length, 1);
  assert.equal(filtered.json().items[0].conversationId, input.conversationId);
  const archived = await app.inject({ method: "POST", url: `/api/scripts/library-script/agent/conversations/${input.conversationId}/archive` });
  assert.equal(archived.statusCode, 200);
  assert.equal(scriptAgent.conversations("library-script").items.find(item => item.id === input.conversationId)?.archived, true);
  assert.ok(scriptAgent.journal.read("library-script", first.id)?.archivedAt);
  assert.equal(scriptAgent.list("library-script", 0, 20, input.conversationId).total, 2);
  assert.throws(() => scriptAgent.start("library-script", { ...input, requestId: randomUUID() }), { code: "CONVERSATION_ARCHIVED" });
});

test("Agent stale proposals cannot overwrite edits; cancelled and recovered turns never mutate drafts", async context => {
  const { store, providers, provider } = setup(context), library = new ScriptLibrary(store), service = new ScriptAgentService(store, providers);
  context.after(async () => { await service.close(); store.close(); });
  await library.create(definition());
  provider.handler = async request => ({ output: proposal(), providerId: provider.id, modelId: request.modelId });
  const input = { providerId: provider.id, modelId: "test-model", prompt: "change", expectedRevision: 0, requestId: randomUUID() };
  const turn = service.start("library-script", input);
  await until(() => service.get("library-script", turn.id).status === "succeeded");
  await library.update("library-script", { ...definition(), expectedRevision: 0 });
  await assert.rejects(service.apply("library-script", { turnId: turn.id, expectedRevision: 0, requestId: randomUUID() }), { code: "REVISION_CONFLICT" });
  provider.handler = request => new Promise((_resolve, reject) => { request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }); });
  const active = service.start("library-script", { ...input, expectedRevision: 1, requestId: randomUUID() });
  await until(() => service.get("library-script", active.id).status === "running");
  service.cancel("library-script", active.id);
  await until(() => service.get("library-script", active.id).status === "cancelled");
  assert.equal(library.detail("library-script").draft!.revision, 1);
  provider.handler = async request => ({ output: { summary: "仅提供说明", changes: [], metadata: {}, testInput: {} }, providerId: provider.id, modelId: request.modelId });
  const clarification = service.start("library-script", { ...input, expectedRevision: 1, requestId: randomUUID() });
  await until(() => service.get("library-script", clarification.id).status === "succeeded");
  const clarificationSummary = service.list("library-script").items.find(item => item.id === clarification.id)!;
  assert.equal(clarificationSummary.summary, "仅提供说明");
  assert.equal(clarificationSummary.hasChanges, false);
  assert.equal(clarificationSummary.hasTestInput, true);
  await assert.rejects(service.apply("library-script", { turnId: clarification.id, expectedRevision: 1, requestId: randomUUID() }), { code: "NO_CHANGES" });
  const journal = new ScriptJournal(store.files), record = journal.read("library-script", turn.id)!;
  journal.save({ ...record, status: "running" });
  const restarted = new ScriptAgentService(store, providers);
  assert.equal(restarted.get("library-script", turn.id).status, "interrupted");
  await restarted.close();
});

test("test retention previews bounded deletion and preserves shared artifacts and published sources", async context => {
  const { store } = setup(context), library = new ScriptLibrary(store); context.after(() => store.close());
  const created = await library.create(definition()); store.publishScript(created.script.id, 0);
  const shared = "shared".repeat(9000), unique = "unique".repeat(9000);
  const old = store.createScriptTest(created.script.id, created.version.id, null, {});
  store.setScriptTestRunning(old.id); store.finishScriptTest(old.id, { status: "succeeded", stdout: unique, stderr: "", output: shared });
  store.exec("UPDATE script_tests SET created_at=? WHERE id=?", Date.now() - 40 * 86400000, old.id);
  const newer = store.createScriptTest(created.script.id, created.version.id, null, {});
  store.setScriptTestRunning(newer.id); store.finishScriptTest(newer.id, { status: "succeeded", stdout: "", stderr: "", output: shared });
  const uniqueRef = JSON.parse(store.one<{ stdout_ref: string }>("SELECT stdout_ref FROM script_tests WHERE id=?", old.id)!.stdout_ref);
  const orphan = library.saveTree({ ...definition("orphan-source"), name: "Orphan" }), oldDate = new Date(Date.now() - 40 * 86400000);
  const orphanDirectory = store.files.path(orphan.path.replace("/tree.json", "")); utimesSync(orphanDirectory, oldDate, oldDate);
  const maintenance = new ScriptMaintenance(store), policy = { keepDays: 30, keepLatest: 1 }, preview = maintenance.preview(created.script.id, policy);
  assert.equal(preview.count, 1);
  const result = maintenance.clean(created.script.id, { ...policy, token: preview.token, requestId: randomUUID() }) as { deletedTests: number };
  assert.equal(result.deletedTests, 1);
  assert.equal(store.scriptTest(newer.id).output, shared);
  assert.equal(store.one("SELECT 1 FROM artifacts WHERE id=?", uniqueRef.artifactId), undefined);
  assert.ok(existsSync(store.files.path(created.version.sourceRef)));
  assert.equal(existsSync(orphanDirectory), false);
});

test("static script contract checks prove supported shapes and flag unknown schemas", () => {
  assert.equal(schemaSubset({ type: "integer" }, { type: "number" }), "compatible");
  assert.equal(schemaSubset({ type: "string" }, { type: "object" }), "incompatible");
  assert.equal(schemaSubset({ enum: [{ ok: true }] }, { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "compatible");
  assert.equal(schemaSubset({ type: "object" }, { type: "object", required: ["ok"], properties: { ok: true } }), "incompatible");
  assert.equal(schemaSubset(true, { type: "object" }), "unknown");
  assert.equal(schemaSubset({ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "string" }), "unknown");
  const schema = bindingSchema({ source: "object", properties: { text: { source: "literal", value: "hello" } } }, {} as never);
  assert.equal(schemaSubset(schema, { type: "object", required: ["text"], properties: { text: { type: "string" } } }), "compatible");
  assert.equal(bindingSchema({ source: "workflow", pointer: "/optional" }, { inputSchema: { type: "object", properties: { optional: { type: "string" } } } } as never), true);
});

test("workflow authoring rejects incompatible literal bindings and runs published Shell JSON versions", async context => {
  const { store, providers, authoring } = setup(context), library = new ScriptLibrary(store), runner = new GraphRunner(store, providers);
  context.after(async () => { await runner.close(); await authoring.close(); store.close(); });
  const source: ScriptDefinition = { ...definition(), runtime: "shell", entryFile: "main.sh", resultMode: "json", inputSchema: { type: "object" }, outputSchema: { type: "object" }, files: { "main.sh": "read -r input; echo progress; printf '%s' \"$input\" > \"$ORCHARD_RESULT_FILE\"" } };
  const script = await library.create(source), published = store.publishScript(script.script.id, 0);
  const draft = await authoring.create(undefined, randomUUID()), files = authoring.snapshot(draft.id).files, graph = JSON.parse(files["workflow.json"]!);
  graph.nodes[0] = { ...graph.nodes[0], type: "script", config: { scriptId: source.id, scriptVersionId: published.version.id }, outputSchema: source.outputSchema, input: { source: "literal", value: "wrong input" } };
  files["workflow.json"] = JSON.stringify(graph);
  const invalid = await authoring.update(draft.id, 0, files);
  assert.equal(invalid.validation.valid, false);
  assert.match(invalid.validation.diagnostics.join(" "), /不兼容/);
  await assert.rejects(authoring.publish(draft.id, 1, randomUUID()));
  graph.nodes[0].input = { source: "literal", value: { ok: true } };
  files["workflow.json"] = JSON.stringify(graph);
  const updated = await authoring.update(draft.id, 1, files); assert.equal(updated.validation.valid, true);
  const version = await authoring.publish(draft.id, 2, randomUUID()), run = runner.create(version.id, {}, randomUUID());
  await until(() => ["succeeded", "failed"].includes(store.run(run.id).status));
  assert.equal(store.run(run.id).status, "succeeded");
  assert.deepEqual(store.run(run.id).output, { ok: true });
  assert.equal(library.references(source.id).items[0]!.scriptVersionId, published.version.id);
});

test("script test HTTP history is paginated and large values use explicit artifacts", async context => {
  const { store, providers } = setup(context), { app, scripts } = createApp(store, providers); context.after(() => app.close());
  await app.ready();
  const input = { text: "a".repeat(40000) };
  await scripts.create({ ...definition(), files: { "main.ts": "export default input => input" } });
  const payload = { draftRevision: 0, input, requestId: randomUUID() };
  const response = await app.inject({ method: "POST", url: "/api/scripts/library-script/tests", payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(response.json().inputArtifactId);
  await until(() => store.scriptTest(response.json().id).status === "succeeded");
  const scriptsList = (await app.inject({ url: "/api/scripts" })).json();
  assert.equal(scriptsList.items[0].latestTest.status, "succeeded");
  const history = await app.inject({ url: "/api/scripts/library-script/tests?limit=1" });
  assert.equal(history.json().total, 1);
  assert.equal(history.json().items.length, 1);
  assert.equal(Object.hasOwn(history.json().items[0], "input"), false);
  const detail = await app.inject({ url: `/api/scripts/library-script/tests/${response.json().id}` });
  assert.ok(detail.json().output.artifact.id);
  assert.deepEqual((await app.inject({ url: `/api/artifacts/${detail.json().inputArtifactId}` })).json(), input);
  assert.equal((await app.inject({ url: "/api/scripts/library-script/tests?limit=101" })).statusCode, 400);
});

test("cleanup refuses changed previews, never removes active tests and preserves retry receipts", async context => {
  const { store, providers } = setup(context), { app, scripts } = createApp(store, providers); context.after(() => app.close());
  await app.ready();
  await scripts.create(definition());
  const makeOld = () => {
    const test = store.createScriptTest("library-script", null, 0, {});
    store.setScriptTestRunning(test.id); store.finishScriptTest(test.id, { status: "succeeded", stdout: "", stderr: "" });
    store.exec("UPDATE script_tests SET created_at=? WHERE id=?", Date.now() - 40 * 86400000, test.id); return test;
  };
  makeOld();
  const active = store.createScriptTest("library-script", null, 0, {});
  const maintenance = new ScriptMaintenance(store), policy = { keepDays: 30, keepLatest: 1 }, preview = maintenance.preview("library-script", policy);
  assert.equal(preview.count, 1);
  makeOld();
  assert.throws(() => maintenance.clean("library-script", { ...policy, token: preview.token, requestId: randomUUID() }), { code: "CLEANUP_CONFLICT" });
  const newer = maintenance.preview("library-script", policy), input = { ...policy, token: newer.token, requestId: randomUUID() };
  const result = maintenance.clean("library-script", input);
  assert.deepEqual(maintenance.clean("library-script", input), result);
  assert.equal(store.scriptTest(active.id).status, "queued");
});

test("cleanup only deletes the confirmed tests when another row expires during the transaction", async context => {
  const { store } = setup(context), library = new ScriptLibrary(store); context.after(() => store.close());
  await library.create(definition());
  const baseTime = Date.now(), duration = 30 * 86400000;
  const complete = (createdAt: number) => {
    const record = store.createScriptTest("library-script", null, 0, {});
    store.setScriptTestRunning(record.id); store.finishScriptTest(record.id, { status: "succeeded", stdout: "", stderr: "" });
    store.exec("UPDATE script_tests SET created_at=? WHERE id=?", createdAt, record.id);
    return record.id;
  };
  const expired = complete(baseTime - duration - 1000), boundary = complete(baseTime - duration + 500);
  complete(baseTime);
  let clock = baseTime;
  context.mock.method(Date, "now", () => clock);
  const maintenance = new ScriptMaintenance(store), policy = { keepDays: 30, keepLatest: 1 }, preview = maintenance.preview("library-script", policy);
  assert.equal(preview.count, 1);
  const transaction = store.transaction.bind(store);
  context.mock.method(store, "transaction", function<Result>(operation: () => Result): Result {
    clock = baseTime + 1000;
    return transaction(operation);
  });
  const result = maintenance.clean("library-script", { ...policy, token: preview.token, requestId: randomUUID() }) as { deletedTests: number };
  assert.equal(result.deletedTests, 1);
  assert.equal(store.one("SELECT id FROM script_tests WHERE id=?", expired), undefined);
  assert.equal(store.scriptTest(boundary).status, "succeeded");
});

test("Agent turns in separate scripts never share a working directory even with the same requestId", async context => {
  const { store, providers, provider } = setup(context), library = new ScriptLibrary(store), service = new ScriptAgentService(store, providers);
  context.after(async () => { await service.close(); store.close(); });
  await library.create(definition("first-script")); await library.create(definition("second-script"));
  const directories: string[] = [], releases: (() => void)[] = [];
  provider.handler = async request => {
    directories.push(request.cwd);
    await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) for (const release of releases) release(); });
    return { output: proposal(), providerId: provider.id, modelId: request.modelId };
  };
  const input = { providerId: provider.id, modelId: "test-model", prompt: "edit", expectedRevision: 0, requestId: "same-request" };
  const first = service.start("first-script", input), second = service.start("second-script", input);
  await until(() => service.get("first-script", first.id).status === "succeeded" && service.get("second-script", second.id).status === "succeeded");
  assert.equal(new Set(directories).size, 2);
});

test("contract checks account for source enum constraints and forbidden optional properties", () => {
  assert.equal(schemaSubset({ type: "string", enum: ["ok", 3] }, { type: "string" }), "compatible");
  assert.equal(schemaSubset({ type: "object", properties: { forbidden: false }, additionalProperties: false }, { type: "object", additionalProperties: false }), "compatible");
  assert.equal(schemaSubset({ type: "array", maxItems: 0 }, { type: "array", items: false }), "compatible");
});

test("legacy script trees remain readable when escaping expands otherwise valid source beyond 8 MiB", context => {
  const { store } = setup(context); context.after(() => store.close());
  const exported = "export default()=>1";
  const files = { "main.ts": "\t".repeat(1024 * 1024 - exported.length) + exported, "a.ts": "\t".repeat(1024 * 1024), "b.ts": "\t".repeat(1024 * 1024), "c.ts": "\t".repeat(1024 * 1024) };
  const content = JSON.stringify({ files }), path = `artifacts/scripts/${digest(content)}/tree.json`, target = store.files.path(path);
  assert.ok(Buffer.byteLength(content) > 8 * 1024 * 1024);
  mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  assert.deepEqual(store.files.readScriptTree(path).files, files);
  assert.ok(existsSync(store.files.path(store.files.saveScriptTree(files).path)));
});
