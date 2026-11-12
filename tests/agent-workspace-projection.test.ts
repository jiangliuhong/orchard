import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWorkspaceProjection, PROJECTION_LIMITS, type ProjectionResource } from "../src/agent/workspace-projection.js";
import type { AssetSnapshot, QueryContext } from "../src/agent/query-gateway.js";
import { AssetQueryHost } from "../src/agent/asset-query-host.js";
import { ScriptLibrary } from "../src/authoring/script-library.js";
import { WebBridgeConfig } from "../src/web-bridge/config.js";
import { setup } from "./helpers.js";

const script = (version = "v1", state: ProjectionResource["state"] = "draft"): ProjectionResource => ({ state, snapshot: {
  kind: "script", id: "sample", name: "Sample", version, revision: "3",
  definition: { id: "sample", name: "Sample", runtime: "nodejs", entryFile: "main.ts" },
  files: { "main.ts": "export default () => 42;", "lib/helper.ts": "export const value = 42;" },
} });
const workflow = (version?: string): ProjectionResource => {
  const definition = { nodes: version ? [{ type: "script", config: { scriptId: "sample", scriptVersionId: version } }] : [] };
  return { state: "published", snapshot: { kind: "workflow", id: "flow", name: "Flow", version: "wf-v1", revision: "content-hash", definition,
    files: { "workflow.json": JSON.stringify(definition), "layout.json": "{}", "scripts/main.ts": "export default () => 1;" } } };
};
const build = (resources: ProjectionResource[], knownSecrets: string[] = []) => buildWorkspaceProjection({ resources, applications: [], knownSecrets });
const rejects = (resources: ProjectionResource[], code: string) => assert.throws(() => build(resources), { code });

test("projection emits deterministic current-state files with stable version metadata, no layout or duplicated library source", () => {
  const resources = [workflow("v1"), script(), script("v2", "published")];
  const first = build(resources), second = build([...resources].reverse());
  assert.deepEqual(first, second);
  assert.match(first.hash, /^[a-f0-9]{64}$/);
  assert.equal(first.bytes, Object.values(first.files).reduce((n, content) => n + Buffer.byteLength(content), 0));
  assert.deepEqual(JSON.parse(first.files["scripts/sample/draft/resource.json"]!), {
    id: "sample", kind: "script", version: "v1", revision: "3", state: "draft", readOnly: true, dependenciesComplete: true,
  });
  assert.equal(first.files["scripts/sample/draft/src/main.ts"], script().snapshot.files["main.ts"]);
  assert.ok(first.files["scripts/sample/published/script.json"]);
  assert.ok(first.files["workflows/flow/published/scripts/main.ts"]);
  assert.equal(first.files["workflows/flow/published/layout.json"], undefined);
  assert.equal(first.files["workflows/flow/draft/workflow.json"], undefined);
  assert.equal(Object.keys(first.files).some(path => path.includes("sessions") || path.includes("AGENTS.md")), false);
  assert.equal(Object.isFrozen(first), true); assert.equal(Object.isFrozen(first.files), true);
  const changed = script(); changed.snapshot.files = { "main.ts": "changed" };
  assert.notEqual(build([changed]).hash, build([script()]).hash);
});

test("browser applications use configured identity, not invented draft/published state", () => {
  const tool: AssetSnapshot = { kind: "bridge_tool", id: "crm/read", name: "read", version: "tool-hash", revision: "tool-hash", definition: { toolId: "read", application: "crm" }, files: {} };
  const result = buildWorkspaceProjection({ resources: [], applications: [{ id: "crm", revision: "app-hash", definition: { id: "crm", name: "CRM", enabled: true }, tools: [tool] }], knownSecrets: [] });
  assert.deepEqual(Object.keys(result.files), ["browser-tools/crm/read/resource.json", "browser-tools/crm/read/tool.json", "browser-tools/crm/resource.json", "project.json"]);
  assert.equal(JSON.parse(result.files["browser-tools/crm/read/resource.json"]!).state, "configured");
  assert.equal(JSON.parse(result.files["browser-tools/crm/resource.json"]!).revision, "app-hash");
  assert.throws(() => buildWorkspaceProjection({ resources: [], applications: [{ id: "other", revision: "hash", definition: {}, tools: [tool] }], knownSecrets: [] }), { code: "PROJECTION_INVALID_RESOURCE" });
});

test("exact historical dependencies cannot silently resolve to current versions", () => {
  rejects([workflow("old"), script("new")], "PROJECTION_DEPENDENCY_MISSING");
  rejects([workflow("old")], "PROJECTION_DEPENDENCY_MISSING");
  assert.ok(build([workflow("v1"), script("v1", "published")]).hash);
  const incomplete = workflow(); incomplete.snapshot.files = { "workflow.json": '{"nodes":[{"type":"script","config":{"scriptId":"sample"}}]}' };
  rejects([incomplete, script()], "PROJECTION_DEPENDENCY_UNKNOWN");
  incomplete.snapshot.files = { "workflow.json": "invalid json" };
  rejects([incomplete], "PROJECTION_DEPENDENCY_UNKNOWN");
  incomplete.snapshot.files = { "workflow.json": '{"nodes":[null]}' };
  rejects([incomplete], "PROJECTION_DEPENDENCY_UNKNOWN");
});

test("browser credential schemas reject nested literal values even when keys and values look ordinary", () => {
  const definition = { execution: { transport: "browser", credentialSchema: {
    properties: { default: { type: "string" }, profile: { anyOf: [{ type: "string", const: "fixture-value" }] } },
  } } };
  const tool: AssetSnapshot = { kind: "bridge_tool", id: "crm/read", name: "read", version: "r1", revision: "r1", definition, files: {} };
  const project = () => buildWorkspaceProjection({ resources: [], applications: [{ id: "crm", revision: "r1", definition: {}, tools: [tool] }], knownSecrets: [] });
  const withheld = project();
  assert.equal(withheld.files["browser-tools/crm/read/tool.json"], undefined);
  assert.equal(JSON.parse(withheld.files["browser-tools/crm/read/resource.json"]!).reason, "QUERY_SENSITIVE_CONTENT");
  assert.ok(!JSON.stringify(withheld.files).includes("fixture-value"));
  definition.execution.credentialSchema.properties.profile.anyOf = [];
  assert.ok(project().files["browser-tools/crm/read/tool.json"]);
});

test("projection rejects traversal, absolute paths, execution files and case-insensitive file/directory collisions", () => {
  for (const id of ["../escape", "/tmp", "a/b", "a\\b", ".", "..", "", "x\n", "a:b"]) {
    const resource = script(); resource.snapshot.id = id;
    rejects([resource], "PROJECTION_INVALID_PATH");
  }
  for (const path of ["../main.ts", "/main.ts", "a//b.ts", "a/./b.ts", "a/../b.ts", "a\\b.ts"]) {
    const resource = script(); resource.snapshot.files = { [path]: "text" };
    rejects([resource], "PROJECTION_INVALID_PATH");
  }
  const unknown = workflow(); unknown.snapshot.files = { ...unknown.snapshot.files, ".pi/extensions/execute.ts": "source" };
  rejects([unknown], "INVALID_PATH");
  rejects([script(), script()], "PROJECTION_COLLISION");
  const caseAlias = script(); caseAlias.snapshot.id = "SAMPLE";
  rejects([script(), caseAlias], "PROJECTION_COLLISION");
  const collisions: Record<string, string>[] = [{ "a.ts": "a", "A.ts": "b" }, { lib: "a", "lib/main.ts": "b" }, { "lib/main.ts": "b", lib: "a" }];
  for (const files of collisions) {
    const resource = script(); resource.snapshot.files = files;
    rejects([resource], "PROJECTION_COLLISION");
  }
});

test("projection withholds an entire sensitive script and keeps other resources readable", () => {
  const resource = script();
  const safe = script(); safe.snapshot.id = "safe-script";
  const assertWithheld = (knownSecrets: string[] = []) => {
    const result = build([resource, safe], knownSecrets);
    const base = "scripts/sample/draft";
    assert.deepEqual(Object.keys(result.files).filter(path => path.startsWith(base)), [`${base}/resource.json`]);
    assert.equal(JSON.parse(result.files[`${base}/resource.json`]!).reason, "QUERY_SENSITIVE_CONTENT");
    assert.equal(JSON.parse(result.files["project.json"]!).resources.find((entry: { path: string }) => entry.path === base).contentWithheld, true);
    assert.ok(result.files["scripts/safe-script/draft/src/main.ts"]);
  };
  for (const content of ['const password = "example";', 'const endpoint = "https://user:pass@example.com";', 'const api_key = "example";']) {
    resource.snapshot.files = { "main.ts": content };
    assertWithheld();
  }
  resource.snapshot.files = { "main.ts": "a local credential value" };
  assertWithheld(["local credential"]);
  resource.snapshot.definition = { password: "example" }; resource.snapshot.files = {};
  assertWithheld();
});

test("projection rejects byte budget overflow without partial output", () => {
  const resource = script();
  resource.snapshot.definition = {}; resource.snapshot.files = { "main.ts": "x".repeat(PROJECTION_LIMITS.fileBytes + 1) };
  rejects([resource], "PROJECTION_TOO_LARGE");
  rejects(Array.from({ length: PROJECTION_LIMITS.resources + 1 }, () => script()), "PROJECTION_TOO_LARGE");
});

test("only approved safe metadata is attached to the two restricted resources", () => {
  const resource = script();
  resource.snapshot.id = "fm-rex-outbound-api";
  resource.snapshot.definition = { runtime: "nodejs", resultMode: "json", outputSchema: true, inputSchema: { password: {} } };
  const tool: AssetSnapshot = { kind: "bridge_tool", id: "fm-rex/outbound_request", name: "outbound_request",
    revision: "1", version: "1", files: {}, definition: { method: "POST", fields: ["result"], execution: { authorization: "fixture" } } };
  const project = (knownSecrets: string[] = []) => buildWorkspaceProjection({
    resources: [resource], applications: [{ id: "fm-rex", revision: "1", definition: {}, tools: [tool] }], knownSecrets,
  }).files;
  const scriptPath = "scripts/fm-rex-outbound-api/draft";
  const toolPath = "browser-tools/fm-rex/outbound_request";
  const files = project();
  for (const [path, expected] of [
    [scriptPath, { runtime: "nodejs", resultMode: "json", outputSchema: true }],
    [toolPath, { method: "POST", fields: ["result"] }],
  ] as const) {
    const metadata = JSON.parse(files[`${path}/resource.json`]!);
    assert.equal(metadata.contentWithheld, true);
    assert.equal(metadata.reason, "QUERY_SENSITIVE_CONTENT");
    assert.deepEqual(metadata.safeMetadata, expected);
    assert.equal(JSON.parse(project(["nodejs", "POST"])[`${path}/resource.json`]!).safeMetadata, undefined);
    assert.deepEqual(Object.keys(files).filter(name => name.startsWith(path + "/")), [`${path}/resource.json`]);
  }
});

test("existing business snapshots project source without artifact paths or storage metadata", async t => {
  const { store, authoring } = setup(t);
  t.after(async () => { await authoring.close(); store.close(); });
  const draft = await authoring.create(undefined, "projection-draft");
  await new ScriptLibrary(store).create({ id: "sample", name: "Sample", description: "Example", runtime: "nodejs", entryFile: "main.ts",
    files: { "main.ts": "export default async () => 42;" }, inputSchema: true, outputSchema: true });
  const host = new AssetQueryHost(store, new WebBridgeConfig(store.root), {
    async authorize() {}, async selectedTest() { return null; }, knownSecrets: () => [],
  });
  const context = { actor: "local", turnId: "test", generation: 1, conversation: { scenario: "workflow", owner_type: "draft", owner_id: draft.id } } as QueryContext;
  const current = await host.current(context);
  const source = await host.get(context, { kind: "script", id: "sample", version: store.script("sample").currentDraftVersionId! });
  const result = build([{ state: "draft", snapshot: current }, { state: "draft", snapshot: source }]);
  assert.equal(result.files[`workflows/${current.id}/drafts/${draft.id}/workflow.json`], current.files["workflow.json"]);
  assert.equal(result.files["scripts/sample/draft/src/main.ts"], source.files["main.ts"]);
  const serialized = JSON.stringify(result.files);
  for (const privateValue of [store.root, "artifactPath", "sourceRef", "selected_test", "workbench.db"]) assert.equal(serialized.includes(privateValue), false);
});

test("one version cannot have different contents across draft/published and validation diagnostics stay private", () => {
  const draft = script(), published = script("v1", "published"); published.snapshot.files = { "main.ts": "different" };
  rejects([draft, published], "PROJECTION_VERSION_MISMATCH");
  draft.snapshot.validation = { valid: false, diagnostics: ["/private/internal/source.ts"] };
  const result = build([draft]);
  assert.equal(JSON.parse(result.files["scripts/sample/draft/resource.json"]!).valid, false);
  assert.equal(JSON.stringify(result.files).includes("/private/internal"), false);
});
