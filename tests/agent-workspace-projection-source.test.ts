import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { WorkspaceProjectionSource, type WorkspaceProjectionBoundary } from "../src/agent/workspace-projection-source.js";
import type { QueryContext } from "../src/agent/query-gateway.js";
import { configCoordinator } from "../src/config-git/coordinator.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { setup, prepareMaintenanceFixture } from "./helpers.js";
import { installWorkspaceBusinessTracking, workspaceSchemaInstalled } from "../src/agent/workspace-business-hooks.js";

const boundary = (overrides: Partial<WorkspaceProjectionBoundary> = {}): WorkspaceProjectionBoundary => ({
  async authorizeProject() {}, async authorize() {}, async selectedTest() { throw new Error("Must not read test data"); }, knownSecrets: () => [], ...overrides,
});
const context = (id: string) => ({ actor: "local", turnId: "projection", generation: 1,
  conversation: { scenario: "workflow", owner_type: "draft", owner_id: id, owner_scope_json: "{}" } }) as QueryContext;
const definition = (text = "42") => ({ id: "sample", name: "Sample", description: "Example", runtime: "nodejs" as const, entryFile: "main.ts",
  files: { "main.ts": `export default async () => ${text};` }, inputSchema: true, outputSchema: true });
async function fixture(t: TestContext, shared = true) {
  const { store, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const releaseTracking = workspaceSchemaInstalled(store) ? installWorkspaceBusinessTracking(store) : () => {};
  t.after(releaseTracking);
  const bridge = shared ? new WebBridgeConfig(store.root, configCoordinator(store)) : new WebBridgeConfig(store.root);
  const draft = await authoring.create(undefined, "projection-draft");
  return { store, authoring, bridge, draft, ctx: context(draft.id), releaseTracking };
}
const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("source collects real current drafts/published versions and sanitized browser configuration without database writes", async t => {
  const { store, authoring, bridge, draft, ctx } = await fixture(t);
  const published = await authoring.publish(draft.id, draft.revision, "projection-publish");
  const current = await authoring.create(published.workflowId, "projection-next-draft");
  const library = new ScriptLibrary(store);
  await library.create(definition("1"));
  const initial = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: initial.revision, requestId: "script-publish" });
  await library.update("sample", { ...definition("2"), expectedRevision: 0 });
  bridge.saveApplication({ id: "crm", name: "CRM" });
  bridge.saveEnvironment("crm", { origin: "https://example.com", profileId: "PRIVATE_PROFILE_MARKER", extensionId: "PRIVATE_EXTENSION_MARKER", bound: true, tabAvailable: true });
  bridge.saveTool({ application: "crm", toolId: "read", site: "crm", description: "Read", path: "/api/read", method: "GET", parameters: { type: "object" }, fields: [], risk: "read", approval: "none", timeoutMs: 1000, catalogVersion: "1", enabled: true });
  let projectChecks = 0;
  const checks: string[] = [];
  const source = new WorkspaceProjectionSource(store, bridge, boundary({
    async authorizeProject() { projectChecks++; }, async authorize(_context, resource) { checks.push(`${resource?.kind}:${resource?.id}:${resource?.version}`); },
  }));
  const before = store.one("SELECT total_changes() AS count");
  const result = await source.collect(ctx, signal());
  assert.deepEqual(store.one("SELECT total_changes() AS count"), before);
  assert.ok(result.files[`workflows/${published.workflowId}/drafts/${current.id}/workflow.json`]);
  assert.ok(result.files[`workflows/${published.workflowId}/published/workflow.json`]);
  assert.equal(JSON.parse(result.files[`workflows/${published.workflowId}/drafts/${current.id}/resource.json`]!).version, `draft:${current.id}`);
  assert.equal(result.files["scripts/sample/published/src/main.ts"], definition("1").files["main.ts"]);
  assert.equal(result.files["scripts/sample/draft/src/main.ts"], definition("2").files["main.ts"]);
  const application = JSON.parse(result.files["browser-tools/crm/resource.json"]!);
  assert.equal(application.revision, bridge.authoringSnapshot("crm").hash);
  assert.deepEqual(application.definition.environments.map((env: object) => Object.keys(env).sort()), [["enabled", "id", "origin"]]);
  assert.ok(result.files["browser-tools/crm/read/tool.json"]);
  for (const value of [store.root, "PRIVATE_PROFILE_MARKER", "PRIVATE_EXTENSION_MARKER", "bound", "tabAvailable", "artifactPath", "sourceRef"]) assert.equal(JSON.stringify(result.files).includes(value), false);
  assert.equal(projectChecks, 2);
  // Every resource is authorized before reading, then again before returning.
  assert.equal(checks.length, 10); assert.equal(new Set(checks).size, 5);
  assert.deepEqual(await source.collect(ctx, signal()), result);
});

test("source requires whole-project authorization, cannot silently filter a denied resource, and rechecks revocation", async t => {
  const { store, bridge, ctx } = await fixture(t);
  let resourceChecks = 0;
  const denied = new WorkspaceProjectionSource(store, bridge, boundary({
    async authorizeProject() { throw new Error("whole project denied"); }, async authorize() { resourceChecks++; },
  }));
  await assert.rejects(denied.collect(ctx, signal()), /whole project denied/);
  assert.equal(resourceChecks, 0);
  const deniedResource = new WorkspaceProjectionSource(store, bridge, boundary({ async authorize() { throw new Error("resource denied"); } }));
  await assert.rejects(deniedResource.collect(ctx, signal()), /resource denied/);
  let projectChecks = 0;
  const revokedProject = new WorkspaceProjectionSource(store, bridge, boundary({ async authorizeProject() { if (++projectChecks === 2) throw new Error("project revoked"); } }));
  await assert.rejects(revokedProject.collect(ctx, signal()), /project revoked/);
  let reads = 0;
  const revokedResource = new WorkspaceProjectionSource(store, bridge, boundary({ async authorize() { if (++reads === 2) throw new Error("resource revoked"); } }));
  await assert.rejects(revokedResource.collect(ctx, signal()), /resource revoked/);
  // All failure paths release the barriers.
  bridge.saveApplication({ id: "after-denial", name: "Still writable" });
});

test("source retains both barriers across awaited authorization, with shared or distinct coordinators", async t => {
  for (const shared of [true, false]) await t.test(shared ? "shared" : "distinct", async t => {
    const { store, bridge, ctx } = await fixture(t, shared);
    const entered = deferred(), release = deferred();
    let checks = 0;
    const source = new WorkspaceProjectionSource(store, bridge, boundary({ async authorizeProject() {
      if (++checks === 1) { entered.resolve(); await release.promise; }
    } }));
    const collected = source.collect(ctx, signal());
    await entered.promise;
    try {
      assert.throws(() => configCoordinator(store).withWrite(() => {}), { code: "CONFIG_BUSY" });
      assert.throws(() => configCoordinator(store).beginActivity("page-write"), { code: "CONFIG_BUSY" });
      assert.throws(() => bridge.saveApplication({ id: "queued", name: "Not applied" }), { code: "CONFIG_BUSY" });
    } finally { release.resolve(); }
    await collected;
    bridge.saveApplication({ id: "after", name: "Applied after snapshot" });
    assert.equal(bridge.application("queued"), undefined);
    assert.ok(bridge.application("after"));
  });
});

test("busy config activities and cancellation fail closed without leaking the read barrier", async t => {
  const { store, bridge, ctx } = await fixture(t);
  const coordinator = configCoordinator(store);
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  const release = coordinator.beginActivity("existing-activity");
  try { await assert.rejects(source.collect(ctx, signal()), { code: "CONFIG_BUSY" }); } finally { release(); }
  const control = new AbortController(); control.abort(new Error("cancelled before read"));
  await assert.rejects(source.collect(ctx, control.signal), /cancelled before read/);
  const during = new AbortController();
  const cancelled = new WorkspaceProjectionSource(store, bridge, boundary({ async authorize() { during.abort(new Error("cancelled during read")); } }));
  await assert.rejects(cancelled.collect(ctx, during.signal), /cancelled during read/);
  coordinator.withWrite(() => {});
  assert.ok((await source.collect(ctx, signal())).hash);
});

test("source presents every workflow draft under stable resource identity and excludes published draft records", async t => {
  const { store, authoring, bridge, draft, ctx } = await fixture(t);
  const published = await authoring.publish(draft.id, draft.revision, "publish");
  const first = await authoring.create(published.workflowId, "first-edit");
  const second = await authoring.create(published.workflowId, "second-edit");
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  const result = await source.collect(ctx, signal());
  const group = JSON.parse(result.files[`workflows/${published.workflowId}/resource.json`]!);
  assert.deepEqual(group.drafts.map((item: { draftId: string }) => item.draftId).sort(), [first.id, second.id].sort());
  assert.equal(group.publishedVersion, published.id);
  assert.equal(result.files[`workflows/${published.workflowId}/drafts/${draft.id}/workflow.json`], undefined);
});

test("a workflow's exact old published script is retained as a discoverable read-only dependency", async t => {
  const { store, authoring, bridge, draft, ctx } = await fixture(t);
  const library = new ScriptLibrary(store);
  await library.create(definition("1"));
  const initial = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: initial.revision, requestId: "old-publish" });
  const files = store.files.readTree(draft.artifactPath).files;
  const workflow = JSON.parse(files["workflow.json"]!);
  workflow.nodes[0] = { ...workflow.nodes[0], type: "script", config: { scriptId: "sample", scriptVersionId: initial.id } };
  await authoring.update(draft.id, draft.revision, { ...files, "workflow.json": JSON.stringify(workflow) });
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  assert.ok((await source.collect(ctx, signal())).files["scripts/sample/published/script.json"]);
  await library.update("sample", { ...definition("2"), expectedRevision: 0 });
  const next = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: next.revision, requestId: "new-publish" });
  const result = await source.collect(ctx, signal());
  assert.equal(result.files[`scripts/sample/versions/${initial.id}/src/main.ts`], definition("1").files["main.ts"]);
  assert.equal(result.files["scripts/sample/published/src/main.ts"], definition("2").files["main.ts"]);
  const index = JSON.parse(result.files["project.json"]!);
  assert.equal(index.dependencies[0].path, `scripts/sample/versions/${initial.id}`);
  assert.equal(index.dependencies[0].readOnly, true);
});

test("unpublished resource identity stays stable through first publication instead of using draft ID", async t => {
  const { store, authoring, bridge, draft, ctx } = await fixture(t);
  const id = JSON.parse(store.files.readTree(draft.artifactPath).files["workflow.json"]!).id;
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  assert.ok((await source.collect(ctx, signal())).files[`workflows/${id}/drafts/${draft.id}/resource.json`]);
  const published = await authoring.publish(draft.id, draft.revision, "stable-first-publish");
  assert.equal(published.workflowId, id);
  assert.ok((await source.collect(ctx, signal())).files[`workflows/${id}/published/resource.json`]);
});

test("installed bindings cannot be silently backfilled, mismatched or discarded for an incomplete draft", async t => {
  const { store, bridge, draft, ctx, releaseTracking } = await fixture(t);
  const original = store.files.readTree(draft.artifactPath).files, id = JSON.parse(original["workflow.json"]!).id;
  releaseTracking();
  prepareMaintenanceFixture(store);
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  await assert.rejects(source.collect(ctx, signal()), { code: "PROJECTION_IDENTITY_UNAVAILABLE" });
  store.exec("INSERT INTO agent_workspace_workflow_bindings VALUES(?,?,?)", draft.id, id, Date.now());
  const tree = store.files.saveTree({ ...original, "workflow.json": "not yet valid JSON" });
  store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", tree.path, draft.id);
  const result = await source.collect(ctx, signal());
  const metadata = JSON.parse(result.files[`workflows/${id}/drafts/${draft.id}/resource.json`]!);
  assert.equal(metadata.valid, false); assert.equal(metadata.dependenciesComplete, false);
  const changed = store.files.saveTree({ ...original, "workflow.json": JSON.stringify({ ...JSON.parse(original["workflow.json"]!), id: "forged" }) });
  store.exec("UPDATE drafts SET artifact_path=? WHERE id=?", changed.path, draft.id);
  await assert.rejects(source.collect(ctx, signal()), { code: "PROJECTION_IDENTITY_CONFLICT" });
});

test("archived referenced scripts remain exact readonly dependencies, not editable current resources", async t => {
  const { store, authoring, bridge, draft, ctx } = await fixture(t);
  const library = new ScriptLibrary(store); await library.create(definition("1"));
  const version = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: version.revision, requestId: "archive-dependency-publish" });
  const files = store.files.readTree(draft.artifactPath).files, workflow = JSON.parse(files["workflow.json"]!);
  workflow.nodes[0] = { ...workflow.nodes[0], type: "script", config: { scriptId: "sample", scriptVersionId: version.id } };
  await authoring.update(draft.id, draft.revision, { ...files, "workflow.json": JSON.stringify(workflow) }); store.archiveScript("sample");
  const result = await new WorkspaceProjectionSource(store, bridge, boundary()).collect(ctx, signal());
  assert.equal(result.files["scripts/sample/published/script.json"], undefined);
  assert.equal(result.files[`scripts/sample/versions/${version.id}/src/main.ts`], definition("1").files["main.ts"]);
});

test("failure to acquire the separate browser barrier releases the business barrier", async t => {
  const { store, bridge, ctx } = await fixture(t, false);
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  const release = bridge.coordinator.beginActivity("browser-change");
  try { await assert.rejects(source.collect(ctx, signal()), { code: "CONFIG_BUSY" }); } finally { release(); }
  configCoordinator(store).withWrite(() => {});
  assert.ok((await source.collect(ctx, signal())).hash);
});

test("source does not export archived scripts, prior published versions or known sensitive values", async t => {
  const { store, bridge, ctx } = await fixture(t);
  const library = new ScriptLibrary(store);
  await library.create(definition());
  const initial = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: initial.revision, requestId: "publish" });
  await library.update("sample", { ...definition("100"), expectedRevision: 0 });
  const next = store.scriptVersion(store.script("sample").currentDraftVersionId!);
  await library.publish("sample", { expectedRevision: next.revision, requestId: "publish-next" });
  const source = new WorkspaceProjectionSource(store, bridge, boundary());
  const result = await source.collect(ctx, signal());
  assert.equal(JSON.parse(result.files["scripts/sample/published/resource.json"]!).version, next.id);
  assert.equal(result.files["scripts/sample/draft/resource.json"], undefined);
  assert.equal(JSON.stringify(result.files).includes(initial.id), false);
  const sensitive = new WorkspaceProjectionSource(store, bridge, boundary({ knownSecrets: () => [definition("100").files["main.ts"]] }));
  const withheld = await sensitive.collect(ctx, signal());
  assert.equal(JSON.parse(withheld.files["scripts/sample/published/resource.json"]!).contentWithheld, true);
  assert.equal(withheld.files["scripts/sample/published/script.json"], undefined);
  assert.equal(withheld.files["scripts/sample/published/src/main.ts"], undefined);
  store.archiveScript("sample");
  assert.equal(Object.keys((await source.collect(ctx, signal())).files).some(path => path.startsWith("scripts/")), false);
});
