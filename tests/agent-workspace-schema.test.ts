import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { WORKSPACE_MAINTENANCE_SCHEMA } from "../src/agent/workspace-schema.js";
import { SCHEMA } from "../src/persistence/schema.js";

const H = "a".repeat(64), K = "b".repeat(64);
const sessionTable = "agent_maintenance_sessions", taskTable = "agent_maintenance_tasks", proposalTable = "agent_maintenance_proposals";
const decisionTable = "agent_maintenance_decisions", applyTable = "agent_maintenance_apply_requests", projectionTable = "agent_workspace_projection_state";
type Row = Record<string, SQLInputValue>;
function insert(db: DatabaseSync, table: string, row: Row, verb = "INSERT") {
  const keys = Object.keys(row);
  db.prepare(`${verb} INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]!));
}
const session = (id = "s1", extra: Row = {}): Row => ({ id, actor_key: "local", scenario: "workflow", owner_kind: "workflow_draft", owner_id: "flow",
  owner_scope_json: '{"draftId":"draft-a"}', mode: "multi", provider_id: "pi", model_id: "model", contract_version: "v1", tool_policy_version: "read-only-v1", knowledge_hash: K,
  generation: 1, revision: 1, lifecycle: "active", native_delete_state: "absent", created_at: 1000, updated_at: 1000, ...extra });
const task = (id = "t1", extra: Row = {}): Row => ({ id, session_id: "s1", mode: "multi", request_id: id, request_hash: H, sequence: 1, generation: 1,
  projection_generation: 1, projection_hash: H, baseline_json: '{"revision":1}', status: "succeeded", process_state: "stopped", created_at: 1000, ended_at: 1050, ...extra });
const proposal = (id = "p1", extra: Row = {}): Row => ({ id, actor_key: "local", session_id: "s1", task_id: "t1", submit_request_id: id, submit_request_hash: H,
  contract_version: "v1", target_kind: "workflow_draft", target_id: "flow", target_scope_json: '{"draftId":"draft-a"}', baseline_json: '{"revision":1}', body_json: '{"after":{}}', before_json: '{}',
  content_hash: H, diff_hash: K, state: "pending", created_at: 1060, expires_at: 2000, ...extra });
const decision = (id = "d1", extra: Row = {}): Row => ({ id, proposal_id: "p1", actor_key: "local", request_id: id, action: "confirm", content_hash: H, diff_hash: K, created_at: 1100, valid_until: 1900, ...extra });
const request = (id = "a1", extra: Row = {}): Row => ({ id, proposal_id: "p1", confirmation_id: "d1", actor_key: "local", request_id: id, request_hash: H,
  state: "queued", attempt_count: 0, created_at: 1200, updated_at: 1200, ...extra });
function fixture(t: TestContext) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE drafts(id TEXT PRIMARY KEY); CREATE TABLE provider_settings(id TEXT PRIMARY KEY); INSERT INTO drafts VALUES('draft-a'); INSERT INTO provider_settings VALUES('pi');");
  db.exec(WORKSPACE_MAINTENANCE_SCHEMA);
  insert(db, projectionTable, { id: "maintenance", target_generation: 1, synced_generation: 1, target_knowledge_hash: K, synced_knowledge_hash: K, content_hash: H, state: "ready", updated_at: 1000 });
  insert(db, sessionTable, session()); insert(db, taskTable, task());
  return db;
}
function confirm(db: DatabaseSync) {
  insert(db, proposalTable, proposal()); insert(db, decisionTable, decision());
  db.exec(`UPDATE ${proposalTable} SET state='confirmed' WHERE id='p1'`);
}
function dirty(db: DatabaseSync) { db.exec(`UPDATE ${projectionTable} SET target_generation=2,state='pending'`); }
function apply(db: DatabaseSync, id = "a1") {
  db.prepare(`UPDATE ${applyTable} SET state='applied',target_generation=2,result_json='{"revision":2}',updated_at=1300,settled_at=1300 WHERE id=?`).run(id);
}

test("workspace schema approval binds the exact user-reviewed snapshot and excludes automatic migration/reset", () => {
  const root = new URL("../", import.meta.url);
  const approval = JSON.parse(readFileSync(new URL("docs/features/2026-11-12-agent-workspace-projection/database-approval.json", root), "utf8"));
  assert.equal(approval.status, "approved"); assert.equal(approval.reviewer, "user"); assert.equal(approval.evidence.message, "确认");
  assert.equal(createHash("sha256").update(readFileSync(new URL(approval.reviewSnapshot, root))).digest("hex"), approval.reviewedDocumentSha256);
  assert.match(approval.authorization, /separate preview and explicit confirmation/);
  assert.match(approval.activation, /Do not change the global schema version/);
  assert.doesNotMatch(WORKSPACE_MAINTENANCE_SCHEMA, /DROP TABLE|PRAGMA user_version|DELETE FROM/i);
});

test("eight-table schema coexists with real legacy business schema without altering old definitions or user_version", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close()); db.exec(SCHEMA);
  const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const version = db.prepare("PRAGMA user_version").get();
  db.exec(WORKSPACE_MAINTENANCE_SCHEMA);
  const after = db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
  const oldNames = new Set(before.map(row => row.name));
  assert.deepEqual(after.filter(row => oldNames.has(row.name)), before);
  assert.deepEqual(db.prepare("PRAGMA user_version").get(), version);
  const added = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().filter(row => !oldNames.has(row.name));
  assert.equal(added.length, 8);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("workflow bindings permit multiple drafts but reject reidentification, invalid paths and absent parents", t => {
  const db = fixture(t); db.exec("INSERT INTO drafts VALUES('draft-b')");
  insert(db, "agent_workspace_workflow_bindings", { draft_id: "draft-a", resource_id: "flow", created_at: 1000 });
  insert(db, "agent_workspace_workflow_bindings", { draft_id: "draft-b", resource_id: "flow", created_at: 1000 });
  assert.throws(() => db.exec("UPDATE agent_workspace_workflow_bindings SET resource_id='other' WHERE draft_id='draft-a'"), /IMMUTABLE/);
  assert.throws(() => insert(db, "agent_workspace_workflow_bindings", { draft_id: "missing", resource_id: "flow", created_at: 1000 }), /FOREIGN KEY/);
  db.exec("INSERT INTO drafts VALUES('invalid')");
  for (const id of ["../flow", "/tmp", ".", "a/b"]) assert.throws(() => insert(db, "agent_workspace_workflow_bindings", { draft_id: "invalid", resource_id: id, created_at: 1000 }), /CHECK/);
  db.exec("DELETE FROM drafts WHERE id='draft-b'");
  assert.equal(db.prepare("SELECT count(*) AS n FROM agent_workspace_workflow_bindings").get()!.n, 1);
});

test("browser revision and projection readiness are constrained and cannot move backward", t => {
  const db = fixture(t);
  insert(db, "bridge_configuration", { id: "current", revision: 1, config_json: '{}', content_hash: H, updated_at: 1000 });
  assert.throws(() => db.exec("UPDATE bridge_configuration SET config_json='{\"changed\":true}'"), /MONOTONIC/);
  db.exec("UPDATE bridge_configuration SET revision=2,config_json='{\"changed\":true}'");
  assert.throws(() => db.exec("UPDATE bridge_configuration SET revision=1"), /MONOTONIC/);
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET target_generation=0`));
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET target_generation=2`), /CHECK/);
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET synced_knowledge_hash=NULL`), /CHECK/);
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET content_hash=NULL`), /CHECK/);
  dirty(db);
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET state='ready'`), /CHECK/);
  db.exec(`UPDATE ${projectionTable} SET synced_generation=2,state='ready'`);
  assert.throws(() => db.exec(`UPDATE ${projectionTable} SET synced_generation=1,state='pending'`), /MONOTONIC/);
});

test("session identity, single non-persistence and native-delete boundaries cannot be bypassed", t => {
  const db = fixture(t);
  for (const column of ["actor_key", "owner_id", "owner_scope_json", "mode", "provider_id", "knowledge_hash"]) {
    assert.throws(() => db.exec(`UPDATE ${sessionTable} SET ${column}='other' WHERE id='s1'`), /IMMUTABLE/);
  }
  db.exec(`UPDATE ${sessionTable} SET generation=2,revision=2 WHERE id='s1'`);
  assert.throws(() => db.exec(`UPDATE ${sessionTable} SET generation=1 WHERE id='s1'`), /MONOTONIC/);
  assert.throws(() => insert(db, sessionTable, session("single-bad", { mode: "single", native_ref_json: '{}', native_ref_version: 1, provider_fingerprint: H, native_delete_state: "present" })), /CHECK/);
  assert.throws(() => db.exec(`DELETE FROM ${sessionTable} WHERE id='s1'`), /UNCONFIRMED/);
  insert(db, sessionTable, session("deleting", { native_delete_state: "unknown" }));
  assert.throws(() => db.exec(`UPDATE ${sessionTable} SET lifecycle='deleted' WHERE id='deleting'`), /CHECK/);
  db.exec(`UPDATE ${sessionTable} SET lifecycle='deleted',native_delete_state='absent' WHERE id='deleting'`);
  assert.throws(() => db.exec(`UPDATE ${sessionTable} SET lifecycle='active' WHERE id='deleting'`), /BUSY/);
});

test("task admission is global, generation/projection bound, and uncertain processes cannot settle or release deletion", t => {
  const db = fixture(t); insert(db, sessionTable, session("s2"));
  insert(db, taskTable, task("active", { sequence: 2, status: "running", process_state: "unknown", ended_at: null }));
  assert.throws(() => insert(db, taskTable, task("other", { session_id: "s2", status: "queued", process_state: "absent", ended_at: null })), /UNIQUE|ROW_EXISTS/);
  assert.throws(() => db.exec(`UPDATE ${taskTable} SET status='failed',ended_at=1200 WHERE id='active'`), /CHECK/);
  assert.throws(() => db.exec(`UPDATE ${sessionTable} SET lifecycle='deleting' WHERE id='s1'`), /BUSY/);
  db.exec(`UPDATE ${taskTable} SET status='interrupted',process_state='stopped',ended_at=1200 WHERE id='active'`);
  assert.throws(() => db.exec(`UPDATE ${taskTable} SET status='running' WHERE id='active'`), /SETTLED/);
  assert.throws(() => insert(db, taskTable, task("wrong-generation", { sequence: 3, generation: 2, status: "queued", process_state: "absent" })), /BLOCKED/);
  db.exec(`UPDATE ${sessionTable} SET native_delete_state='unknown' WHERE id='s2'`);
  assert.throws(() => insert(db, taskTable, task("uncertain-native", { session_id: "s2", status: "queued", process_state: "absent" })), /BLOCKED/);
  dirty(db);
  assert.throws(() => insert(db, taskTable, task("not-ready", { sequence: 3, status: "queued", process_state: "absent" })), /BLOCKED/);
});

test("single task has exactly one logical round and task input identity is immutable", t => {
  const db = fixture(t); insert(db, sessionTable, session("single", { mode: "single" }));
  insert(db, taskTable, task("single-task", { session_id: "single", mode: "single" }));
  assert.throws(() => insert(db, taskTable, task("single-more", { session_id: "single", mode: "single", sequence: 2 })), /CHECK|UNIQUE|ROW_EXISTS/);
  assert.throws(() => insert(db, taskTable, task("mode-mismatch", { session_id: "single", mode: "multi", sequence: 2 })), /FOREIGN KEY/);
  assert.throws(() => db.exec(`UPDATE ${taskTable} SET baseline_json='{}' WHERE id='t1'`), /IMMUTABLE/);
});

test("proposal binds fixed owner, source task and baseline and freezes all confirmed content", t => {
  const db = fixture(t);
  const invalid: Row[] = [{ actor_key: "other" }, { target_id: "other" }, { target_scope_json: '{}' }, { baseline_json: '{}' }, { state: "applied" }];
  for (const change of invalid) {
    assert.throws(() => insert(db, proposalTable, proposal("bad", change)), /OWNER/);
  }
  insert(db, sessionTable, session("s2")); insert(db, taskTable, task("t2", { session_id: "s2" }));
  assert.throws(() => insert(db, proposalTable, proposal("cross-session", { task_id: "t2" })), /OWNER|FOREIGN KEY/);
  confirm(db);
  for (const [column, value] of Object.entries({ body_json: '{}', before_json: '{"changed":true}', baseline_json: '{}', content_hash: K, diff_hash: H,
    target_id: "other", target_scope_json: '{}', actor_key: "other", expires_at: 3000 })) {
    assert.throws(() => db.prepare(`UPDATE ${proposalTable} SET ${column}=? WHERE id='p1'`).run(value), /IMMUTABLE/);
  }
  assert.throws(() => db.exec(`UPDATE ${proposalTable} SET state='applied'`), /PROPOSAL_STATE/);
});

test("confirmation requires exact actor/content/diff and validity; revocation cannot be edited or reconfirmed", t => {
  const db = fixture(t); insert(db, proposalTable, proposal());
  const invalid: Row[] = [{ actor_key: "other" }, { content_hash: K }, { diff_hash: H }, { valid_until: 2100 }];
  for (const change of invalid) {
    assert.throws(() => insert(db, decisionTable, decision("bad", change)), /BINDING/);
  }
  assert.throws(() => db.exec(`UPDATE ${proposalTable} SET state='confirmed'`), /PROPOSAL_STATE/);
  insert(db, decisionTable, decision()); db.exec(`UPDATE ${proposalTable} SET state='confirmed'`);
  assert.throws(() => db.exec(`UPDATE ${decisionTable} SET content_hash='${K}'`), /IMMUTABLE/);
  insert(db, decisionTable, decision("revoke", { action: "revoke", valid_until: null, created_at: 1200 }));
  db.exec(`UPDATE ${proposalTable} SET state='revoked'`);
  assert.throws(() => insert(db, applyTable, request()), /CONFIRMATION/);
  assert.throws(() => db.exec(`UPDATE ${proposalTable} SET state='confirmed'`), /PROPOSAL_STATE/);
  assert.throws(() => insert(db, decisionTable, decision("reconfirm")), /BINDING|UNIQUE/);
});

test("apply requests reject absent/unconfirmed/cross-proposal authority, duplicate request IDs and mutable payload identities", t => {
  const db = fixture(t); insert(db, proposalTable, proposal());
  assert.throws(() => insert(db, applyTable, request()), /CONFIRMATION/);
  insert(db, decisionTable, decision());
  assert.throws(() => insert(db, applyTable, request()), /CONFIRMATION/);
  db.exec(`UPDATE ${proposalTable} SET state='confirmed'`);
  assert.throws(() => insert(db, applyTable, request("bad-actor", { actor_key: "other" })), /CONFIRMATION/);
  assert.throws(() => insert(db, applyTable, request("expired", { created_at: 1950 })), /CONFIRMATION/);
  insert(db, proposalTable, proposal("p2"));
  assert.throws(() => insert(db, applyTable, request("wrong-proposal", { proposal_id: "p2" })), /CONFIRMATION|FOREIGN KEY/);
  insert(db, applyTable, request());
  assert.throws(() => insert(db, applyTable, request("same-request", { request_id: "a1" })), /UNIQUE|ROW_EXISTS/);
  assert.throws(() => db.exec(`UPDATE ${applyTable} SET proposal_id='p2'`), /IMMUTABLE/);
  assert.throws(() => insert(db, applyTable, request("fake-success", { state: "applied", target_generation: 1, result_json: '{}', settled_at: 1200 })), /CONFIRMATION/);
});

test("applied receipt requires registered dirty generation and quiescent tasks; success is immutable and once per proposal", t => {
  const db = fixture(t); confirm(db); insert(db, applyTable, request()); insert(db, applyTable, request("a2"));
  assert.throws(() => apply(db), /APPLY_BLOCKED/);
  insert(db, taskTable, task("active", { sequence: 2, status: "running", process_state: "running", ended_at: null }));
  dirty(db); assert.throws(() => apply(db), /APPLY_BLOCKED/);
  db.exec(`UPDATE ${taskTable} SET status='succeeded',process_state='stopped',ended_at=1250 WHERE id='active'`);
  db.exec("BEGIN"); apply(db); db.exec(`UPDATE ${proposalTable} SET state='applied'`); db.exec("COMMIT");
  assert.equal(db.prepare(`SELECT state FROM ${applyTable} WHERE id='a1'`).get()!.state, "applied");
  assert.throws(() => db.exec(`UPDATE ${applyTable} SET state='queued' WHERE id='a1'`), /IMMUTABLE/);
  assert.throws(() => apply(db, "a2"), /APPLY_BLOCKED|UNIQUE/);
  assert.throws(() => db.exec(`UPDATE ${proposalTable} SET state='pending'`), /PROPOSAL_STATE/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("confirmation is rechecked at commit and a transaction failure does not claim applied or advance projection", t => {
  const db = fixture(t); confirm(db); insert(db, applyTable, request());
  insert(db, decisionTable, decision("revoke", { action: "revoke", valid_until: null, created_at: 1250 }));
  dirty(db); assert.throws(() => apply(db), /APPLY_BLOCKED/);
  assert.equal(db.prepare(`SELECT state FROM ${applyTable}`).get()!.state, "queued");
  // Isolated second fixture for transaction rollback, no real business database.
  const other = fixture(t); confirm(other); insert(other, applyTable, request());
  other.exec("BEGIN");
  dirty(other); apply(other);
  assert.throws(() => other.exec(`UPDATE ${proposalTable} SET content_hash='${K}'`), /IMMUTABLE/);
  other.exec("ROLLBACK");
  assert.equal(other.prepare(`SELECT target_generation FROM ${projectionTable}`).get()!.target_generation, 1);
  assert.equal(other.prepare(`SELECT state FROM ${applyTable}`).get()!.state, "queued");
  assert.equal(other.prepare(`SELECT state FROM ${proposalTable}`).get()!.state, "confirmed");
});

test("INSERT OR REPLACE cannot replace identities, confirmations, receipts or an active task through a unique-index conflict", t => {
  const db = fixture(t); confirm(db); insert(db, applyTable, request());
  insert(db, "bridge_configuration", { id: "current", revision: 1, config_json: '{}', content_hash: H, updated_at: 1000 });
  insert(db, "agent_workspace_workflow_bindings", { draft_id: "draft-a", resource_id: "flow", created_at: 1000 });
  const replacements: [string, Row][] = [
    ["bridge_configuration", { id: "current", revision: 99, config_json: '{}', content_hash: H, updated_at: 1000 }],
    ["agent_workspace_workflow_bindings", { draft_id: "draft-a", resource_id: "other", created_at: 1000 }],
    [projectionTable, { id: "maintenance", target_generation: 1, synced_generation: 0, target_knowledge_hash: K, state: "pending", updated_at: 1000 }],
    [sessionTable, session("s1", { actor_key: "other" })], [taskTable, task()],
    [proposalTable, proposal()], [decisionTable, decision("replacement-confirm")],
    [applyTable, request("replacement-request", { request_id: "a1" })],
  ];
  for (const [table, row] of replacements) assert.throws(() => insert(db, table, row, "INSERT OR REPLACE"), /ROW_EXISTS|BINDING/);
  insert(db, taskTable, task("active", { sequence: 2, status: "running", process_state: "unknown", ended_at: null }));
  insert(db, sessionTable, session("s2"));
  assert.throws(() => insert(db, taskTable, task("replacement-active", { session_id: "s2", status: "queued", process_state: "absent" }), "INSERT OR REPLACE"), /ROW_EXISTS/);
  assert.equal(db.prepare(`SELECT id FROM ${decisionTable}`).get()!.id, "d1");
  assert.equal(db.prepare(`SELECT id FROM ${applyTable}`).get()!.id, "a1");
  assert.equal(db.prepare(`SELECT status FROM ${taskTable} WHERE id='active'`).get()!.status, "running");
});

test("JSON type/UTF-8 byte budgets, hash format, safe integers and TTL limits reject invalid records", t => {
  const db = fixture(t);
  for (const before of ['[]', 'null', '{', JSON.stringify({ source: "中".repeat(3 * 1024 * 1024) })]) {
    assert.throws(() => insert(db, proposalTable, proposal("bad", { before_json: before })), /CHECK/);
  }
  assert.throws(() => insert(db, proposalTable, proposal("ttl", { expires_at: 1060 + 604800001 })), /CHECK/);
  assert.throws(() => insert(db, sessionTable, session("big", { revision: Number.MAX_SAFE_INTEGER + 1 })), /CHECK/);
  assert.throws(() => insert(db, sessionTable, session("hash", { knowledge_hash: "A".repeat(64) })), /CHECK/);
  assert.throws(() => insert(db, sessionTable, session("fraction", { generation: 1.5 })), /CHECK/);
  insert(db, proposalTable, proposal("long-lived", { expires_at: 100000000 }));
  assert.throws(() => insert(db, decisionTable, decision("ttl-confirm", { proposal_id: "long-lived", valid_until: 1100 + 86400001 })), /CHECK/);
});
