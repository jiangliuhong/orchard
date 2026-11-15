import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { applyQuickLaunchV12, backfillQuickLaunchV12 } from "../src/migrations/quick-launch-v12.js";

const v11 = readFileSync(new URL("../docs/features/2026-11-06-data-migration/sql/db.initialize-v11.sql", import.meta.url), "utf8");
const v12 = readFileSync(new URL("../docs/features/2026-11-14-quick-launch/sql/db.v11-v12.sql", import.meta.url), "utf8");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "orchard-v12-test-"));
  mkdirSync(join(root, "runtime"));
  const db = new DatabaseSync(":memory:");
  db.exec(v11);
  return { db, root, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("v12 copies only safe legacy summaries and can verify them again without duplicates", () => {
  const { db, root, close } = fixture();
  try {
    writeFileSync(join(root, "runtime/bridge-history.json"), JSON.stringify([
      { id: "old-browser", startedAt: 10, durationMs: 3, status: "succeeded", args: { secret: "legacy-secret" } }
    ]));
    db.exec("BEGIN IMMEDIATE");
    const counts = applyQuickLaunchV12(db, root, v12);
    assert.deepEqual(counts, { workflow_run: 0, script_test: 0, bridge_call: 1 });
    assert.deepEqual(backfillQuickLaunchV12(db, root), counts);
    const rows = db.prepare("SELECT * FROM execution_records").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "legacy_unknown");
    assert.equal(rows[0].ended_at, 13);
    assert.equal(rows[0].output_availability, "not_recorded");
    assert.doesNotMatch(JSON.stringify(rows), /legacy-secret/);
    assert.equal(db.prepare("SELECT count(*) AS total FROM execution_outbox").get()?.total, 0);
    db.exec("COMMIT");
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 12);
  } finally { close(); }
});

test("v12 rejects duplicate browser identities and caller rollback preserves v11", () => {
  const { db, root, close } = fixture();
  try {
    const entry = { id: "duplicate", startedAt: 10, durationMs: 3, status: "failed" };
    writeFileSync(join(root, "runtime/bridge-history.json"), JSON.stringify([entry, entry]));
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => applyQuickLaunchV12(db, root, v12), { code: "DATABASE_CORRUPT" });
    db.exec("ROLLBACK");
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 11);
    assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='execution_records'").get(), undefined);
  } finally { close(); }
});

test("v12 backfills a queued workflow without dispatch while retaining its original row", () => {
  const { db, root, close } = fixture();
  try {
    db.exec(`INSERT INTO workflows(id,name,created_at,updated_at) VALUES('workflow','例行',0,0);
      INSERT INTO workflow_versions(id,workflow_id,version_no,definition_json,layout_json,artifact_path,content_hash,created_at)
        VALUES('version','workflow',1,'{}','{}','unused','hash',0);
      INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES('run','version','queued','{}',0);`);
    const before = db.prepare("SELECT * FROM runs").all();
    db.exec("BEGIN IMMEDIATE");
    assert.equal(applyQuickLaunchV12(db, root, v12).workflow_run, 1);
    assert.deepEqual(db.prepare("SELECT * FROM runs").all(), before);
    assert.equal(db.prepare("SELECT status FROM execution_records WHERE underlying_id='run'").get()?.status, "queued");
    assert.equal(db.prepare("SELECT count(*) AS total FROM execution_outbox").get()?.total, 0);
    db.exec("COMMIT");
  } finally { close(); }
});
