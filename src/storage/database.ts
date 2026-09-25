import { mkdirSync, openSync, closeSync, writeSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";

const MIGRATION = readFileSync(new URL("../../migrations/001-initial.sql", import.meta.url), "utf8");

export interface OrchardDatabase {
  readonly dataDir: string;
  readonly database: DatabaseSync;
  close(): void;
}

export function initializeDatabase(dataDir: string): OrchardDatabase {
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = join(runtimeDir, "orchard.lock");
  let lockFd: number;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    writeSync(lockFd, `${process.pid}\n`);
  } catch (error) {
    throw new Error(`Another Orchard instance is using data directory ${root}`, { cause: error });
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(root, "orchard.db"));
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    database.exec("BEGIN IMMEDIATE;");
    const current = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (current < 1) {
      database.exec(MIGRATION);
      database.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(1, "001-initial", Date.now());
    }
    database.exec("COMMIT;");
  } catch (error) {
    try { database?.close(); } catch { /* preserve migration error */ }
    closeSync(lockFd);
    if (existsSync(lockPath)) unlinkSync(lockPath);
    throw new Error(`Failed to initialize Orchard database at ${root}`, { cause: error });
  }

  if (!database) throw new Error(`Database was not opened at ${root}`);
  let closed = false;
  return {
    dataDir: root,
    database,
    close(): void {
      if (closed) return;
      closed = true;
      database.close();
      closeSync(lockFd);
      if (existsSync(lockPath)) unlinkSync(lockPath);
    },
  };
}

export { EventRepository, StepRepository, WorkflowRepository, RunRepository } from "./repository.js";

export function createDefaultWorkspace(db: OrchardDatabase, rootPath = join(db.dataDir, "workspaces", "default")): string {
  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const existing = db.database.prepare("SELECT id FROM workspaces WHERE name = 'default' LIMIT 1").get() as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuidv7();
  const now = Date.now();
  db.database.prepare("INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, 'default', ?, ?, ?)").run(id, resolve(rootPath), now, now);
  return id;
}
