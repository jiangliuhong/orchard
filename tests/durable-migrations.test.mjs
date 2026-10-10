import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile, readdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase, backupDatabase } from '../dist/storage/database.js';

test('upgrade from v3 preserves history and creates a restorable pre-migration snapshot', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'orchard-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(join(dir, 'orchard.db'));
  for (const name of ['001-initial', '002-workflow-runtime', '003-workflow-version-integrity']) old.exec(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
  old.exec("INSERT INTO workspaces VALUES ('w','legacy','legacy',0,0); INSERT INTO workflows (id,workspace_id,name,description,status,created_at,updated_at) VALUES ('f','w','legacy','','active',0,0); INSERT INTO workflow_versions (id,workflow_id,version_no,content_hash,source_path,bundle_path,manifest_json,sdk_version,created_at) VALUES ('v','f',1,'hash','source','bundle','{}','1',0); INSERT INTO runs (id,workflow_version_id,status,created_at) VALUES ('r','v','succeeded',0); INSERT INTO run_events (id,run_id,sequence_no,event_type,created_at) VALUES ('e','r',1,'run.succeeded',0);");
  old.close();
  const upgraded = initializeDatabase(dir);
  assert.equal(upgraded.database.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(upgraded.database.prepare("SELECT status FROM runs WHERE id = 'r'").get().status, 'succeeded');
  const backups = await readdir(join(dir, 'runtime', 'backups'));
  assert.equal(backups.length, 1);
  const snapshotPath = join(dir, 'runtime', 'backups', backups[0]);
  const snapshot = new DatabaseSync(snapshotPath);
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM run_events').get().n, 1);
  snapshot.close();
  const manual = backupDatabase(upgraded);
  const check = new DatabaseSync(manual);
  assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  check.close();
  upgraded.close();
  // Offline rollback restores the previous runtime's data and schema together.
  await rm(join(dir, 'orchard.db-wal'), { force: true });
  await rm(join(dir, 'orchard.db-shm'), { force: true });
  await copyFile(snapshotPath, join(dir, 'orchard.db'));
  const restored = new DatabaseSync(join(dir, 'orchard.db'));
  assert.equal(restored.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  restored.close();
});
