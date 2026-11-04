import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setup, temporary } from "./helpers.js";
import { Store } from "../src/persistence/store.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

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
