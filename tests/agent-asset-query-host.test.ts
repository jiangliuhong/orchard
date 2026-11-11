import assert from "node:assert/strict";
import { test } from "node:test";
import { AssetQueryHost } from "../src/agent/asset-query-host.js";
import type { QueryContext } from "../src/agent/query-gateway.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { exampleFiles, setup } from "./helpers.js";

const context = (ownerId: string, scenario = "workflow", ownerType = "draft", scope = {}) => ({ actor: "local", turnId: "turn", generation: 1,
  conversation: { owner_id: ownerId, scenario, owner_type: ownerType, owner_scope_json: JSON.stringify(scope) } }) as QueryContext;

test("asset host reads real script/workflow source, rejects mismatched versions and binds current draft", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const bridge = new WebBridgeConfig(store.root);
  const draft = await authoring.create(undefined, "draft");
  const library = new ScriptLibrary(store);
  await library.create({ id: "sample", name: "Sample", description: "Example", runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default async function(input: unknown) { return input; }" }, inputSchema: true, outputSchema: true });
  const script = store.script("sample"), scriptVersion = store.scriptVersion(script.currentDraftVersionId!);
  const host = new AssetQueryHost(store, bridge, { async authorize() {}, async selectedTest() { return null; }, knownSecrets: () => [] });
  const current = await host.current(context(draft.id));
  assert.equal(current.revision, String(draft.revision)); assert.ok(Object.hasOwn(current.files, "workflow.json"));
  const read = await host.get(context(draft.id), { kind: "script", id: "sample", version: scriptVersion.id });
  assert.equal(read.files["main.ts"], "export default async function(input: unknown) { return input; }");
  assert.equal((read.definition as Record<string, unknown>).files, undefined);
  await assert.rejects(host.get(context(draft.id), { kind: "workflow", id: "other", version: current.version }), { code: "NOT_FOUND" });
  const scriptContext = context("sample", "script", "script", { draftVersionId: scriptVersion.id });
  assert.equal((await host.current(scriptContext)).version, scriptVersion.id);
  await assert.rejects(host.current(context("sample", "script", "script", { draftVersionId: "replaced" })), { code: "OWNER_UNAVAILABLE" });
});

test("asset search pagination binds query and snapshot; references include exact script versions", async t => {
  const { store, authoring } = setup(t); t.after(async () => { await authoring.close(); store.close(); });
  const bridge = new WebBridgeConfig(store.root), draft = await authoring.create(undefined, "draft");
  await new ScriptLibrary(store).create({ id: "sample", name: "Sample", description: "", runtime: "nodejs", entryFile: "main.ts", files: { "main.ts": "export default async function(input: unknown) { return input; }" }, inputSchema: true, outputSchema: true });
  const version = store.script("sample").currentDraftVersionId!;
  const files = exampleFiles(), definition = JSON.parse(files["workflow.json"]!);
  definition.nodes[0] = { ...definition.nodes[0], type: "script", config: { scriptId: "sample", scriptVersionId: version } };
  files["workflow.json"] = JSON.stringify(definition);
  const tree = store.files.saveTree(files);
  store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", tree.path, draft.id);
  const host = new AssetQueryHost(store, bridge, { async authorize() {}, async selectedTest() { return null; }, knownSecrets: () => [] }), ctx = context(draft.id);
  const first = await host.search(ctx, { query: "", limit: 1 });
  assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
  assert.equal((await host.search(ctx, { query: "", cursor: first.nextCursor!, limit: 1 })).items.length, 1);
  await assert.rejects(host.search(ctx, { query: "Sample", cursor: first.nextCursor!, limit: 1 }), { code: "QUERY_CURSOR_STALE" });
  const references = await host.references(ctx, { kind: "script", id: "sample", version }, undefined, 20);
  assert.equal(references.items.length, 1);
  assert.deepEqual(references.items[0]!.target, { kind: "script", id: "sample", version });
  assert.equal(references.items[0]!.source.version, `draft:${draft.id}`);
});
