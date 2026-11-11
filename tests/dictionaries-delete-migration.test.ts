import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { MIGRATE_V9_TO_V10, SCHEMA } from "../src/persistence/schema.js";
import { captureRows, verifyMapping } from "../src/migrations/mapping.js";
import { verifyDatabase } from "../src/migrations/validators.js";

test("v9→v10 preserves populated dictionaries and history; initialization matches upgrade", () => {
  const db = new DatabaseSync(":memory:"), fresh = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync("tests/fixtures/migrations/database/v9.sql", "utf8"));
    db.exec("PRAGMA foreign_keys=ON; BEGIN");
    db.exec("INSERT INTO dictionaries VALUES('dict','Config','plain','v1',1,1,1)");
    db.prepare("INSERT INTO dictionary_versions VALUES('v1','dict',1,'Config','','plain',1,'{}',?,1)").run("a".repeat(64));
    db.exec("COMMIT");
    const before = captureRows(db);
    db.exec(MIGRATE_V9_TO_V10);
    verifyMapping(db, before, 9, 10);
    assert.equal(verifyDatabase(db), 10);
    assert.equal(db.prepare("SELECT deleted_at FROM dictionaries").get()!.deleted_at, null);
    assert.throws(() => db.exec("DELETE FROM dictionary_versions"), /DICTIONARY_VERSION_IMMUTABLE/);
    fresh.exec(SCHEMA);
    assert.equal(verifyDatabase(fresh), 10);
    const objects = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    // The shared verifier compares normalized SQL; historical table formatting may differ.
    assert.deepEqual(db.prepare(objects).all().map(({ type, name }) => [type, name]), fresh.prepare(objects).all().map(({ type, name }) => [type, name]));
    db.exec("UPDATE dictionaries SET deleted_at=1,revision=2");
    assert.throws(() => db.exec("UPDATE dictionary_versions SET enabled=0"), /DICTIONARY_VERSION_IMMUTABLE/);
    db.exec("BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM dictionary_versions; DELETE FROM dictionaries; ROLLBACK;");
    assert.equal(db.prepare("SELECT count(*) n FROM dictionary_versions").get()!.n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM dictionaries").get()!.n, 1);
    db.exec("BEGIN; PRAGMA defer_foreign_keys=ON; DELETE FROM dictionary_versions; DELETE FROM dictionaries; COMMIT;");
    assert.equal(db.prepare("SELECT count(*) n FROM dictionary_versions").get()!.n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { db.close(); fresh.close(); }
});
