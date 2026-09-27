import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDefaultWorkspace, initializeDatabase } from "../dist/storage/database.js";

test("database initialization applies schema, WAL, foreign keys and default workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-storage-"));
  const storage = initializeDatabase(dir);
  try {
    assert.equal(storage.database.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(storage.database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    assert.equal(storage.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    const workspaceId = createDefaultWorkspace(storage);
    const row = storage.database.prepare("SELECT id, name FROM workspaces WHERE id = ?").get(workspaceId);
    assert.deepEqual({ ...row }, { id: workspaceId, name: "default" });
    assert.equal(createDefaultWorkspace(storage), workspaceId);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("one data directory permits only one live Orchard instance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-lock-"));
  const first = initializeDatabase(dir);
  try {
    assert.throws(() => initializeDatabase(dir), /Another Orchard instance/);
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock left by an exited process is reclaimed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-stale-lock-"));
  const runtimeDir = join(dir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "orchard.lock"), "999999\n");
  const storage = initializeDatabase(dir);
  try {
    assert.equal(storage.database.prepare("PRAGMA user_version").get().user_version, 1);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
