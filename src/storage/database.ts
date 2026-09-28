import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { v7 as uuidv7 } from "uuid";

const MIGRATIONS = [
  { version: 1, name: "001-initial", sql: readFileSync(new URL("../../migrations/001-initial.sql", import.meta.url), "utf8") },
  { version: 2, name: "002-workflow-runtime", sql: readFileSync(new URL("../../migrations/002-workflow-runtime.sql", import.meta.url), "utf8") },
] as const;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the process no longer exists. Treat every other result,
    // including EPERM, as alive so we never remove another user's lock.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireLock(lockPath: string): number {
  try {
    const lockFd = openSync(lockPath, "wx", 0o600);
    writeSync(lockFd, `${process.pid}\n`);
    return lockFd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    let ownerPid: number | undefined;
    try {
      const contents = readFileSync(lockPath, "utf8").trim();
      if (/^\d+$/.test(contents)) ownerPid = Number(contents);
    } catch {
      // The lock may have been replaced or removed while it was inspected.
    }

    if (ownerPid === undefined || isProcessAlive(ownerPid)) throw error;

    // The recorded owner has exited, so this is a lock left by a crashed
    // instance. Unlink it and race safely with any process acquiring it.
    unlinkSync(lockPath);
    const lockFd = openSync(lockPath, "wx", 0o600);
    writeSync(lockFd, `${process.pid}\n`);
    return lockFd;
  }
}

export interface OrchardDatabase {
  readonly dataDir: string;
  readonly database: DatabaseSync;
  close(): void;
}

/** The default per-user Orchard instance root. Tests and embedders may override it. */
export function defaultInstanceRoot(): string {
  return join(homedir(), ".orchard");
}

function prepareDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  // mkdir's mode is affected by umask and does not fix an existing directory.
  chmodSync(path, 0o700);
}

function assertWritableInstanceRoot(root: string): void {
  prepareDirectory(root);
  const stats = statfsSync(root);
  if (stats.bavail * stats.bsize < 1024 * 1024) throw new Error(`Insufficient disk space for Orchard instance ${root}`);
  try {
    const probe = join(root, `.write-check-${process.pid}-${Date.now()}`);
    const fd = openSync(probe, "wx", 0o600);
    closeSync(fd);
    unlinkSync(probe);
  } catch (error) {
    throw new Error(`Orchard instance root is not writable: ${root}`, { cause: error });
  }
}

export function initializeDatabase(dataDir = defaultInstanceRoot()): OrchardDatabase {
  const root = resolve(dataDir);
  assertWritableInstanceRoot(root);
  const runtimeDir = join(root, "runtime");
  prepareDirectory(runtimeDir);
  for (const directory of ["artifacts", "imports", "tmp", "logs", "workspaces"]) prepareDirectory(join(root, directory));
  const lockPath = join(runtimeDir, "orchard.lock");
  let lockFd: number;
  try {
    lockFd = acquireLock(lockPath);
  } catch (error) {
    throw new Error(`Another Orchard instance is using data directory ${root}`, { cause: error });
  }

  let database: DatabaseSync | undefined;
  try {
    const databasePath = join(root, "orchard.db");
    database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    database.exec("BEGIN IMMEDIATE;");
    const current = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (current > 0 && existsSync(databasePath)) {
      const backupDir = join(runtimeDir, "backups");
      prepareDirectory(backupDir);
      copyFileSync(databasePath, join(backupDir, `orchard-${Date.now()}-v${current}.db`));
    }
    for (const migration of MIGRATIONS) {
      if (current >= migration.version) continue;
      database.exec(migration.sql);
      database.prepare("INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, Date.now());
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

export { AuthoringSessionRepository, EventRepository, ScheduleRepository, StepRepository, WorkflowRepository, RunRepository, WorkflowTaskRepository } from "./repository.js";
export { OperationsLog } from "./operations-log.js";
export type { OperationLogEntry } from "./operations-log.js";

export function createDefaultWorkspace(db: OrchardDatabase, rootPath = join(db.dataDir, "workspaces", "default")): string {
  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const existing = db.database.prepare("SELECT id FROM workspaces WHERE name = 'default' LIMIT 1").get() as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuidv7();
  const now = Date.now();
  db.database.prepare("INSERT INTO workspaces (id, name, root_path, created_at, updated_at) VALUES (?, 'default', ?, ?, ?)").run(id, resolve(rootPath), now, now);
  return id;
}
