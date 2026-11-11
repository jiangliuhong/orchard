import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PlatformQueryGateway, PLATFORM_QUERY_SCHEMAS, assertQuerySafe, type PlatformQueryHost, type AssetSnapshot } from "../src/agent/query-gateway.js";
import { PLATFORM_READ_TOOL_NAMES } from "../src/agent/knowledge-bundle.js";
import { executionFixture } from "./agent-execution-fixtures.js";

function fixture(t: TestContext) {
  const f = executionFixture(t), turn = f.start();
  const snapshot: AssetSnapshot = { kind: "workflow", id: "draft-id", name: "Workflow", revision: "7", version: "draft", definition: { nodes: [], edges: [] }, files: { "scripts/main.ts": "first\nsecond\nthird" } };
  let authorized = true, authorizations = 0, selected = false, reads = 0, now = 1;
  const host: PlatformQueryHost = {
    async authorize() { authorizations++; assert.ok(authorized, "permission revoked"); },
    async search() { return { items: [{ kind: "workflow", id: snapshot.id, name: snapshot.name, revision: snapshot.revision }], nextCursor: null }; },
    async get() { reads++; return snapshot; },
    async current() { reads++; return snapshot; },
    async references() { return { items: [], nextCursor: null }; },
    async selectedTest() { return selected ? { status: "succeeded" } : null; },
    assertSafe: assertQuerySafe,
  };
  const gateway = new PlatformQueryGateway(f.store, host, () => now);
  const controller = new AbortController();
  const grant = gateway.issue({ actor: f.actor, conversationId: f.conversation.id, turnId: turn.id, generation: 1, signal: controller.signal, ttlMs: 100 });
  return { ...f, turn, snapshot, host, gateway, controller, grant, revokePermission() { authorized = false; }, advance() { now += 101; }, select() { selected = true; }, counts: () => ({ authorizations, reads }) };
}

test("platform query allowlist exactly matches built-in declaration; arbitrary tools and extra arguments fail", async t => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(PLATFORM_QUERY_SCHEMAS).sort(), [...PLATFORM_READ_TOOL_NAMES].sort());
  await assert.rejects(f.gateway.call(f.grant.token, "scripts.run", {}), { code: "QUERY_TOOL_FORBIDDEN" });
  await assert.rejects(f.gateway.call(f.grant.token, "current.get", { ownerId: "other" }));
  await assert.rejects(f.gateway.call(f.grant.token, "current.selected_test", { testId: "invented" }));
  assert.equal(f.counts().reads, 0);
});

test("current.get records real per-turn revision proof only after authorization and safety checks", async t => {
  const f = fixture(t);
  assert.throws(() => f.store.recordProposalBaseline(f.actor, f.turn.id, "7"), { code: "BASELINE_NOT_QUERIED" });
  const result = await f.gateway.call(f.grant.token, "current.get", {}) as { revision: string; files: unknown[]; sourceIncluded: boolean };
  assert.equal(result.revision, "7"); assert.equal(result.sourceIncluded, false);
  f.store.recordProposalBaseline(f.actor, f.turn.id, "7");
  assert.throws(() => f.store.recordProposalBaseline(f.actor, f.turn.id, "8"), { code: "BASELINE_NOT_QUERIED" });
  assert.ok(f.counts().authorizations >= 3);
});

test("source reads stay resource-relative, explicitly bounded and version-bound", async t => {
  const f = fixture(t);
  const input = { kind: "workflow", id: "draft-id", path: "scripts/main.ts", startLine: 2, lineCount: 1 };
  assert.deepEqual(await f.gateway.call(f.grant.token, "assets.read_file", input), { kind: "workflow", id: "draft-id", version: "draft", revision: "7", path: "scripts/main.ts", startLine: 2, content: "second", nextLine: 3, truncated: true });
  for (const path of ["../secret", "/etc/passwd", "scripts/../main.ts", "scripts\\main.ts", "scripts//main.ts", "scripts/./main.ts"])
    await assert.rejects(f.gateway.call(f.grant.token, "assets.read_file", { ...input, path }), { code: "INVALID_SOURCE_PATH" });
  await assert.rejects(f.gateway.call(f.grant.token, "assets.read_file", { ...input, version: "wrong" }), { code: "QUERY_RESULT_INVALID" });
  await assert.rejects(f.gateway.call(f.grant.token, "assets.read_file", { ...input, startLine: 99 }));
  f.snapshot.files = { "scripts/main.ts": "x".repeat(32769) };
  await assert.rejects(f.gateway.call(f.grant.token, "assets.read_file", { ...input, startLine: 1 }), { code: "QUERY_SOURCE_LINE_TOO_LARGE" });
});

test("sensitive source cannot leak through a safe slice or install proposal proof", async t => {
  const f = fixture(t);
  f.snapshot.files = { "scripts/main.ts": 'safe\nconst password = "value";' };
  await assert.rejects(f.gateway.call(f.grant.token, "assets.read_file", { kind: "workflow", id: "draft-id", path: "scripts/main.ts", lineCount: 1 }), { code: "QUERY_SENSITIVE_CONTENT" });
  await assert.rejects(f.gateway.call(f.grant.token, "current.get", {}), { code: "QUERY_SENSITIVE_CONTENT" });
  assert.throws(() => f.store.recordProposalBaseline(f.actor, f.turn.id, "7"), { code: "BASELINE_NOT_QUERIED" });
  assert.throws(() => assertQuerySafe({ source: "hardcoded-value" }, ["hardcoded-value"]), { code: "QUERY_SENSITIVE_CONTENT" });
});

test("query grants expire, cancel, revoke explicitly and cannot outlive settled turns", async t => {
  for (const action of ["expire", "cancel", "revoke", "settle"] as const) {
    await t.test(action, async t => {
      const f = fixture(t);
      if (action === "expire") f.advance();
      if (action === "cancel") f.controller.abort();
      if (action === "revoke") f.gateway.revokeConversation(f.conversation.id);
      if (action === "settle") f.store.settle(f.actor, f.turn.id, { generation: 1, status: "succeeded" });
      await assert.rejects(f.gateway.call(f.grant.token, "current.get", {}));
      assert.equal(f.counts().reads, 0);
    });
  }
});

test("single, wrong actor, wrong generation and disabled policy cannot obtain maintenance grants", t => {
  const f = fixture(t);
  for (const input of [{ actor: "other", generation: 1 }, { actor: f.actor, generation: 2 }]) assert.throws(() => f.gateway.issue({ ...input, conversationId: f.conversation.id, turnId: f.turn.id, signal: f.controller.signal }));
  const single = executionFixture(t, "single"), turn = single.start();
  assert.throws(() => new PlatformQueryGateway(single.store, f.host).issue({ actor: single.actor, conversationId: single.conversation.id, turnId: turn.id, generation: 1, signal: f.controller.signal }), { code: "QUERY_AUTHORIZATION_REVOKED" });
});

test("permissions and cancellation are rechecked after asynchronous resource reads", async t => {
  const f = fixture(t);
  f.host.current = async () => { f.revokePermission(); return f.snapshot; };
  await assert.rejects(f.gateway.call(f.grant.token, "current.get", {}), /permission revoked/);
  assert.throws(() => f.store.recordProposalBaseline(f.actor, f.turn.id, "7"));
});

test("query gateway exposes only the selected current test; large current definitions return bounded metadata", async t => {
  const f = fixture(t);
  assert.equal(await f.gateway.call(f.grant.token, "current.selected_test", {}), null);
  f.select(); assert.deepEqual(await f.gateway.call(f.grant.token, "current.selected_test", {}), { status: "succeeded" });
  f.snapshot.definition = { text: "x".repeat(65537) };
  const metadata = await f.gateway.call(f.grant.token, "current.get", {}) as { definitionIncluded: boolean; revision: string };
  assert.equal(metadata.definitionIncluded, false);
  assert.equal(metadata.revision, "7");
  f.store.recordProposalBaseline(f.actor, f.turn.id, "7");
  f.host.selectedTest = async () => ({ text: "x".repeat(65537) });
  await assert.rejects(f.gateway.call(f.grant.token, "current.selected_test", {}), { code: "QUERY_RESULT_TOO_LARGE" });
});
