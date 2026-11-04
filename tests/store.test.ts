import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { publishExample, setup, temporary } from "./helpers.js";
import { Store } from "../src/persistence/store.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SCHEMA, RUN_SCHEMA } from "../src/persistence/schema.js";

const legacyRunSchema = `
CREATE TABLE runs (
 id TEXT PRIMARY KEY, workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
 status TEXT NOT NULL CHECK(status IN ('queued','running','cancel_requested','succeeded','failed','cancelled','interrupted')),
 input_ref TEXT NOT NULL, output_ref TEXT, active_node_id TEXT, cancel_requested_at INTEGER, error_json TEXT,
 created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER
);
`;

test("approved schema has twelve tables and isolates unknown databases", t => {
  const root = temporary(t), store = new Store(root);
  assert.equal(store.all("SELECT name FROM sqlite_master WHERE type='table'").length, 12);
  assert.throws(() => new Store(root), /已有/); store.close();
  const unknownRoot = temporary(t), database = new DatabaseSync(join(unknownRoot, "workbench.db"));
  database.exec("CREATE TABLE old_data(id TEXT)"); database.close();
  assert.throws(() => new Store(unknownRoot), /未知数据库/);
});
test("commands are transactional and keyed by request content", t => {
  const { store } = setup(t); t.after(() => store.close());
  let calls = 0;
  assert.deepEqual(store.command("test", "key", { a: 1 }, () => ({ id: ++calls })), { id: 1 });
  assert.deepEqual(store.command("test", "key", { a: 1 }, () => ({ id: ++calls })), { id: 1 });
  assert.throws(() => store.command("test", "key", { a: 2 }, () => 3), /不同内容/);
  assert.throws(() => store.command("failed", "key", {}, () => { throw new Error("rollback"); }));
  assert.equal(store.one("SELECT * FROM command_receipts WHERE scope='failed'"), undefined);
  const ordered = store.command("ordering", "key", { a: 1, b: 2 }, () => true);
  assert.equal(store.command("ordering", "key", { b: 2, a: 1 }, () => false), ordered);
});
test("events emit only after commit and references verify artifact integrity", async t => {
  const { store, authoring } = setup(t); t.after(() => store.close());
  const draft = await authoring.create(undefined, randomUUID());
  const runId = randomUUID();
  // Use a turn stream to exercise foreign-key and stream ownership validation.
  store.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,created_at) VALUES(?,?,?,'test-model',1,'running',0,?)", runId, draft.id, "test-provider", Date.now());
  const seen: number[] = []; store.events.on("event", event => seen.push(event.sequence));
  assert.throws(() => store.transaction(() => { store.append("authoring_turn", runId, "test", {}); throw new Error("rollback"); }));
  assert.equal(seen.length, 0); assert.equal(store.stream("authoring_turn", runId).length, 0);
  const big = "x".repeat(50000); store.append("authoring_turn", runId, "test", { big });
  assert.deepEqual(seen, [1]); assert.deepEqual(store.stream("authoring_turn", runId)[0]!.payload, { big });
  store.events.on("event", () => { throw new Error("disconnected subscriber"); });
  assert.doesNotThrow(() => store.append("authoring_turn", runId, "committed", {}));
  assert.equal(store.lastSequence("authoring_turn", runId), 2);
  assert.throws(() => store.append("run", "missing", "bad", {}), /不存在/);
});

test("schema v1 upgrades atomically and preserves runs, node references, events, artifacts and request receipts", async t => {
  const { root, store, authoring } = setup(t), version = await publishExample(authoring);
  const runId = randomUUID(), nodeId = randomUUID(), now = Date.now();
  const inputRef = store.reference({ text: "x".repeat(50000) });
  store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,output_ref,created_at,started_at,ended_at) VALUES(?,?,'succeeded',?,?,?, ?,?)", runId, version.id, inputRef, store.reference({ ok: true }), now, now, now);
  store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,'a','code.nodejs','succeeded')", nodeId, runId);
  store.exec("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,started_at) VALUES(?,?,1,'succeeded','{}',?)", randomUUID(), nodeId, now);
  store.append("run", runId, "run.succeeded", { output: { ok: true } });
  store.command("migration-test", "request", {}, () => ({ id: runId }));
  const before = { run: store.run(runId), nodes: store.nodes(runId), attempts: store.attempts(runId), events: store.stream("run", runId), version: store.version(version.id) };
  store.close();
  const legacy = new DatabaseSync(join(root, "workbench.db"));
  legacy.exec(`PRAGMA foreign_keys=OFF; BEGIN;
    ${legacyRunSchema.replace("CREATE TABLE runs (", "CREATE TABLE legacy_runs (")}
    INSERT INTO legacy_runs SELECT id,workflow_version_id,status,input_ref,output_ref,active_node_id,cancel_requested_at,error_json,created_at,started_at,ended_at FROM runs;
    DROP TABLE runs; ALTER TABLE legacy_runs RENAME TO runs;
    CREATE INDEX queued_runs ON runs(status,created_at);
    PRAGMA user_version=1; COMMIT;`);
  legacy.close();
  const upgraded = new Store(root);
  assert.equal(upgraded.one("PRAGMA user_version")!.user_version, 2);
  assert.equal(upgraded.one("PRAGMA foreign_keys")!.foreign_keys, 1);
  assert.deepEqual(upgraded.all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(upgraded.run(runId), before.run);
  assert.deepEqual(upgraded.nodes(runId), before.nodes);
  assert.deepEqual(upgraded.attempts(runId), before.attempts);
  assert.deepEqual(upgraded.stream("run", runId), before.events);
  assert.deepEqual(upgraded.version(version.id), before.version);
  assert.deepEqual(upgraded.command("migration-test", "request", {}, () => assert.fail("receipt lost")), { id: runId });
  assert.throws(() => upgraded.exec("INSERT INTO runs(id,status,input_ref,created_at) VALUES('missing-source','queued','{}',0)"), /CHECK/);
  assert.throws(() => upgraded.exec("INSERT INTO runs(id,workflow_version_id,draft_id,draft_revision,snapshot_path,status,input_ref,created_at) VALUES('mixed',?,?,0,'snapshot','queued','{}',0)", version.id, "missing"), /CHECK/);
  upgraded.close();
  const reopened = new Store(root);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.run(runId), before.run);
});

test("failed v1 migration rolls back the table, schema version and index", t => {
  const root = temporary(t), database = new DatabaseSync(join(root, "workbench.db"));
  database.exec(SCHEMA.replace(RUN_SCHEMA, legacyRunSchema).replace("PRAGMA user_version = 2", "PRAGMA user_version = 1"));
  database.exec("PRAGMA foreign_keys=OFF; INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('orphan','missing-version','queued','{}',0)");
  database.close();
  assert.throws(() => new Store(root), /升级外键校验失败/);
  const original = new DatabaseSync(join(root, "workbench.db"));
  t.after(() => original.close());
  assert.equal(original.prepare("PRAGMA user_version").get()!.user_version, 1);
  assert.equal(original.prepare("SELECT id FROM runs").get()!.id, "orphan");
  assert.ok(original.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='queued_runs'").get());
  assert.equal(original.prepare("SELECT name FROM sqlite_master WHERE name='runs_v2'").get(), undefined);
  assert.equal(original.prepare("PRAGMA table_info(runs)").all().some(column => column.name === "draft_id"), false);
});
