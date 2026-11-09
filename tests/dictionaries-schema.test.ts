import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, initializationSql } from "../src/migrations/frozen.js";
import { MIGRATE_V8_TO_V9, SCHEMA } from "../src/persistence/schema.js";
import { TestStore } from "./helpers.js";
import type { TestContext } from "node:test";

const DICTIONARY_TABLES = ["dictionaries", "dictionary_versions", "run_dictionary_bindings", "script_test_dictionary_bindings"];

test("registered dictionary migration SQL and initialization match the reviewed constants", () => {
  assert.equal(sql[8], MIGRATE_V8_TO_V9);
  assert.equal(initializationSql, SCHEMA);
  assert.equal(SCHEMA.includes("run_dictionary_bindings"), true);
  assert.match(SCHEMA, /PRAGMA user_version = 9;/);
});

test("fresh v9 database keeps new tables empty with active integrity triggers", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "orchard-v9-fresh-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const store = new TestStore(root);
  t.after(() => store.close());
  assert.equal(Number(store.one("PRAGMA user_version")!.user_version), 9);
  for (const table of DICTIONARY_TABLES) assert.equal(Number(store.one(`SELECT count(*) AS n FROM ${table}`)!.n), 0);
  // 指针回切：新增版本后仅 UPDATE 对象并递增 revision，不改动旧版本 version_no。
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES(?,?,?,'v1',1,?,?)", "dict-1", "订单服务", "plain", 1000, 1000);
    store.exec("INSERT INTO dictionary_versions VALUES('v1','dict-1',1,'订单服务','','plain',1,'{}',?,1000)", "a".repeat(64));
  });
  store.transaction(() => {
    store.exec("INSERT INTO dictionary_versions VALUES('v0','dict-1',2,'订单服务','','plain',1,'{\"k\":1}',?,2000)", "b".repeat(64));
    store.exec("UPDATE dictionaries SET current_version_id='v0', revision=2, updated_at=2000 WHERE id='dict-1'");
  });
  assert.deepEqual(store.all<{ id: string }>("SELECT id FROM dictionary_versions ORDER BY version_no").map(row => row.id), ["v1", "v0"]);
  assert.equal(store.one<{ revision: number }>("SELECT revision FROM dictionaries WHERE id='dict-1'")!.revision, 2);
  const expectAbort = (statement: string, message: string) => {
    assert.throws(() => store.exec(statement), new RegExp(message));
  };
  expectAbort("UPDATE dictionary_versions SET name='改名' WHERE id='v1'", "DICTIONARY_VERSION_IMMUTABLE");
  expectAbort("DELETE FROM dictionary_versions WHERE id='v1'", "DICTIONARY_VERSION_IMMUTABLE");
  expectAbort("UPDATE dictionaries SET kind='encrypted' WHERE id='dict-1'", "DICTIONARY_IDENTITY_IMMUTABLE");
  expectAbort("UPDATE dictionaries SET id='dict-x' WHERE id='dict-1'", "DICTIONARY_IDENTITY_IMMUTABLE");
  // NOCASE 命名冲突：重命名与插入均拒绝；未 trim 名称拒绝。
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES(?,?,?,'v3',1,?,?)", "dict-2", "QIDAN", "plain", 3000, 3000);
    store.exec("INSERT INTO dictionary_versions VALUES('v3','dict-2',1,'QIDAN','','plain',1,'{}',?,3000)", "c".repeat(64));
  });
  const expectReject = (statement: string) => {
    assert.throws(() => store.exec(statement), /constraint failed/i);
  };
  expectReject("UPDATE dictionaries SET name='订单服务' WHERE id='dict-2'");
  expectReject("INSERT INTO dictionaries VALUES('dict-3','订单服务','plain','v9',1,1,1)");
  expectReject("INSERT INTO dictionaries VALUES('dict-4',' 前导空格','plain','v4',1,1,1)");
  // 跨表 kind 一致外键。
  expectReject("INSERT INTO dictionary_versions VALUES('v4','dict-2',2,'QIDAN','','encrypted',1,'{}',?,3000)".replace("?,3000", `'${"d".repeat(64)}',3000`));
  assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.equal(store.all("PRAGMA foreign_key_check").length, 0);
});

test("deferred current pointer foreign key allows same-transaction creation and blocks dangling commits", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "orchard-v9-deferred-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const store = new TestStore(root);
  t.after(() => store.close());
  // 同一事务创建对象与首版，提交时延迟外键满足。
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES(?,?,?,'v-ok',1,?,?)", randomUUID(), "同时创建", "plain", Date.now(), Date.now());
    store.exec("INSERT INTO dictionary_versions VALUES('v-ok',?,?,?,?,'plain',1,'{}',?,?)",
      store.one<{ id: string }>("SELECT id FROM dictionaries WHERE name='同时创建'")!.id, 1, "同时创建", "", "e".repeat(64), Date.now());
  });
  assert.equal(store.one("SELECT id FROM dictionary_versions WHERE id='v-ok'")!.id, "v-ok");
  // 悬空指针回滚且不残留。
  assert.throws(() => store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES('dangling','悬空','plain','vx',1,1,1)");
  }), /FOREIGN KEY/);
  assert.equal(store.one("SELECT id FROM dictionaries WHERE id='dangling'"), undefined);
  // 对象名称与版本名称不一致在提交时拒绝（事务内不得改写版本，触发器先行保护）。
  assert.throws(() => store.transaction(() => {
    store.exec("UPDATE dictionaries SET name='不一致' WHERE name='同时创建'");
  }), /FOREIGN KEY/);
  assert.equal(store.one("SELECT name FROM dictionaries WHERE name='不一致'"), undefined);
});

test("v8 databases upgrade in place to v9 preserving rows and keeping new tables empty", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "orchard-v9-upgrade-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const fixture = readFileSync("tests/fixtures/migrations/database/v8.sql", "utf8");
  const db = new DatabaseSync(join(root, "workbench.db"));
  db.exec(fixture);
  // v8 库内预置业务数据行，迁移后必须原样保留。
  const now = Date.now();
  db.prepare("INSERT INTO provider_settings VALUES('legacy-provider',1,'{}','[]','model-a',1,?)").run(now);
  db.prepare("INSERT INTO scripts VALUES('legacy-script','遗留脚本','','nodejs','draft',NULL,NULL,?,?,NULL)").run(now, now);
  db.close();
  const store = new TestStore(root);
  t.after(() => store.close());
  assert.equal(Number(store.one("PRAGMA user_version")!.user_version), 9);
  const provider = store.one<{ id: string; revision: number }>("SELECT id, revision FROM provider_settings WHERE id='legacy-provider'");
  assert.equal(provider!.id, "legacy-provider");
  assert.equal(provider!.revision, 1);
  assert.equal(store.one("SELECT id FROM scripts WHERE id='legacy-script'")!.id, "legacy-script");
  for (const table of DICTIONARY_TABLES) assert.equal(Number(store.one(`SELECT count(*) AS n FROM ${table}`)!.n), 0);
  assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.equal(store.all("PRAGMA foreign_key_check").length, 0);
  // 升级后的库可立即写入字典并通过触发器保护。
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES('post-upgrade','升级后','encrypted','pv1',1,?,?)", now, now);
    store.exec("INSERT INTO dictionary_versions VALUES('pv1','post-upgrade',1,'升级后','','encrypted',1,'{}',?,?)", "f".repeat(64), now);
  });
  assert.throws(() => store.exec("DELETE FROM dictionary_versions WHERE id='pv1'"), /DICTIONARY_VERSION_IMMUTABLE/);
});

test("binding tables enforce run/test ownership and cascade on test deletion", (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "orchard-v9-bindings-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const store = new TestStore(root);
  t.after(() => store.close());
  const now = Date.now();
  store.transaction(() => {
    store.exec("INSERT INTO dictionaries VALUES('dict-c','凭据字典','encrypted','cv1',1,?,?)", now, now);
    store.exec("INSERT INTO dictionary_versions VALUES('cv1','dict-c',1,'凭据字典','','encrypted',1,'{}',?,?)", "9".repeat(64), now);
    store.exec("INSERT INTO scripts VALUES('script-c','级联脚本','','nodejs','draft',NULL,NULL,?,?,NULL)", now, now);
    store.exec("INSERT INTO script_tests VALUES('test-c','script-c',NULL,0,'queued','{}',NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL)", now);
    store.exec("INSERT INTO script_test_dictionary_bindings VALUES('test-c','dict-c','cv1','[\"apiToken\"]',?)", now);
    // 负向用例使用独立的 test 行，避免主键冲突先行触发。
    store.exec("INSERT INTO script_tests VALUES('test-miss-v','script-c',NULL,0,'queued','{}',NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL)", now);
    store.exec("INSERT INTO script_tests VALUES('test-miss-d','script-c',NULL,0,'queued','{}',NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,NULL)", now);
  });
  // 伪造归属拒绝：未存在的 run/test、不存在的版本、不存在的字典。
  const expectFk = (statement: string, ...params: (string | number)[]) => {
    try {
      store.exec(statement, ...params);
      assert.fail("预期外键拒绝");
    } catch (error) {
      assert.match(String(error), /FOREIGN KEY/);
    }
  };
  expectFk("INSERT INTO run_dictionary_bindings VALUES('missing-run','dict-c','cv1','[\"apiToken\"]',?)", now);
  expectFk("INSERT INTO script_test_dictionary_bindings VALUES('missing-test','dict-c','cv1','[\"apiToken\"]',?)", now);
  expectFk("INSERT INTO script_test_dictionary_bindings VALUES('test-miss-v','dict-c','missing-version','[\"apiToken\"]',?)", now);
  expectFk("INSERT INTO script_test_dictionary_bindings VALUES('test-miss-d','missing-dict','cv1','[\"apiToken\"]',?)", now);
  // keys_json 必须为非空数组。
  assert.throws(() => store.exec("INSERT INTO script_test_dictionary_bindings VALUES('test-c','dict-c','cv1','[]',?)", now), /CHECK/);
  // 删除 script_tests 级联清除绑定，不触碰字典与版本。
  store.transaction(() => store.exec("DELETE FROM script_tests WHERE id='test-c'"));
  assert.equal(Number(store.one("SELECT count(*) AS n FROM script_test_dictionary_bindings")!.n), 0);
  assert.equal(store.one("SELECT id FROM dictionary_versions WHERE id='cv1'")!.id, "cv1");
  assert.equal(store.one("SELECT id FROM dictionaries WHERE id='dict-c'")!.id, "dict-c");
});
