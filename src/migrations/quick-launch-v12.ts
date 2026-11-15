import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { parseStrictJson } from "../dictionaries/canonical.js";
import { canonical, hash, present, safe } from "./journal.js";
import { MigrationError } from "./types.js";

type LegacyKind = "workflow_run" | "script_test" | "bridge_call";
type LegacyStatus = "queued" | "succeeded" | "failed" | "cancelled" | "interrupted";
type LegacyExecution = {
  kind: LegacyKind;
  id: string;
  status: LegacyStatus;
  accepted: number;
  started: number | null;
  ended: number | null;
  browser?: { application: string; tool: string; environmentId: string | null };
};

const migratableStatuses = new Set(["queued", "succeeded", "failed", "cancelled", "interrupted"]);
const targetKinds = { workflow_run: "workflow", script_test: "script", bridge_call: "browser_tool" };

function requiredTime(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new MigrationError("DATABASE_CORRUPT");
  return value;
}

function optionalTime(value: unknown): number | null {
  return value === null ? null : requiredTime(value);
}

function* legacyRows(db: DatabaseSync, root: string): Generator<LegacyExecution> {
  const sources = [["runs", "workflow_run"], ["script_tests", "script_test"]] as const;
  for (const [table, kind] of sources) {
    const rows = db.prepare(`SELECT id, status, created_at, started_at, ended_at FROM ${table} ORDER BY id`);
    for (const row of rows.iterate()) {
      if (typeof row.id !== "string" || !row.id || !migratableStatuses.has(String(row.status))) throw new MigrationError("INVALID_STATE");
      yield { kind, id: row.id, status: row.status as LegacyStatus, accepted: requiredTime(row.created_at), started: optionalTime(row.started_at), ended: optionalTime(row.ended_at) };
    }
  }

  const path = safe(root, "runtime/bridge-history.json");
  if (!present(path)) return;
  let history: unknown;
  try {
    history = parseStrictJson(readFileSync(path, "utf8"));
  } catch {
    throw new MigrationError("DATABASE_CORRUPT");
  }
  if (!Array.isArray(history)) throw new MigrationError("DATABASE_CORRUPT");
  const seen = new Set<string>();
  for (const entry of history) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.id !== "string" || !entry.id || seen.has(entry.id) ||
        (entry.status !== "succeeded" && entry.status !== "failed")) throw new MigrationError("DATABASE_CORRUPT");
    seen.add(entry.id);
    const started = requiredTime(entry.startedAt);
    const browser = typeof entry.application === "string" && typeof entry.toolId === "string" ?
      { application: entry.application, tool: entry.toolId, environmentId: typeof entry.environmentId === "string" ? entry.environmentId : null } : undefined;
    yield { kind: "bridge_call", id: entry.id, status: entry.status,
      accepted: started, started, ended: requiredTime(started + requiredTime(entry.durationMs)), ...(browser ? { browser } : {}) };
  }
}

function snapshotFor(execution: LegacyExecution) {
  return JSON.stringify({ inline: { legacy: true, acceptedAtEstimated: execution.kind === "bridge_call", ...execution.browser } });
}

/** Backfills the disposable migration copy inside the caller's transaction. */
export function backfillQuickLaunchV12(db: DatabaseSync, workRoot: string) {
  if (!db.isTransaction) throw new MigrationError("INVALID_STATE");
  const insert = db.prepare(`INSERT INTO execution_records (
    id, source, target_kind, request_scope, request_id, request_digest, snapshot_ref,
    underlying_kind, underlying_id, status, privacy_policy, accepted_at, started_at, ended_at, output_availability
  ) VALUES (?, 'legacy_unknown', ?, ?, ?, ?, ?, ?, ?, ?, 'legacy_unknown', ?, ?, ?, ?)`);
  const existing = db.prepare(`SELECT id, request_scope, request_id, request_digest
    FROM execution_records WHERE underlying_kind=? AND underlying_id=?`);
  const counts = { workflow_run: 0, script_test: 0, bridge_call: 0 };

  for (const execution of legacyRows(db, workRoot)) {
    const { kind, id, status, accepted, started, ended } = execution;
    const scope = `legacy:${kind}`;
    const recordId = `legacy-${hash(canonical([kind, id]))}`;
    const digest = hash(canonical(execution));
    const previous = existing.get(kind, id);
    if (previous) {
      if (previous.id !== recordId || previous.request_scope !== scope || previous.request_id !== id ||
          previous.request_digest !== digest) throw new MigrationError("DATABASE_CORRUPT");
    } else {
      const snapshot = snapshotFor(execution);
      // Database engines keep the original detail behind their existing access and redaction checks.
      const availability = kind === "bridge_call" ? "not_recorded" : "restricted";
      insert.run(recordId, targetKinds[kind], scope, id, digest, snapshot, kind, id, status, accepted, started, ended, availability);
    }
    counts[kind]++;
  }
  return counts;
}

export function applyQuickLaunchV12(db: DatabaseSync, workRoot: string, ddl: string) {
  if (!db.isTransaction || db.prepare("PRAGMA user_version").get()?.user_version !== 11)
    throw new MigrationError("CHAIN_UNSUPPORTED");
  db.exec(ddl);
  backfillQuickLaunchV12(db, workRoot);
  const counts = verifyQuickLaunchV12(db, workRoot);
  if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length) throw new MigrationError("DATABASE_CORRUPT");
  db.exec("PRAGMA user_version=12");
  return counts;
}

/** Checks the full mapping without creating or updating rows. */
export function verifyQuickLaunchV12(db: DatabaseSync, root: string) {
  const counts = { workflow_run: 0, script_test: 0, bridge_call: 0 };
  const select = db.prepare(`SELECT id, source, target_kind, request_scope, request_id, request_digest,
    status, accepted_at, started_at, ended_at, snapshot_ref, privacy_policy, output_availability,
    parent_execution_id, launch_id FROM execution_records WHERE underlying_kind=? AND underlying_id=?`);
  for (const execution of legacyRows(db, root)) {
    const { kind, id, status, accepted, started, ended } = execution;
    const row = select.get(kind, id);
    if (!row || row.id !== `legacy-${hash(canonical([kind, id]))}` ||
        row.request_scope !== `legacy:${kind}` || row.request_id !== id ||
        row.request_digest !== hash(canonical(execution)) || row.source !== "legacy_unknown" ||
        row.target_kind !== targetKinds[kind] || row.status !== status ||
        row.accepted_at !== accepted || row.started_at !== started || row.ended_at !== ended ||
        row.snapshot_ref !== snapshotFor(execution) ||
        row.privacy_policy !== "legacy_unknown" || row.output_availability !== (kind === "bridge_call" ? "not_recorded" : "restricted") ||
        row.parent_execution_id !== null || row.launch_id !== null) throw new MigrationError("DATABASE_CORRUPT");
    counts[kind]++;
  }
  const expected = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (db.prepare("SELECT count(*) AS total FROM execution_records").get()?.total !== expected ||
      db.prepare("SELECT count(*) AS total FROM execution_outbox").get()?.total !== 0)
    throw new MigrationError("DATABASE_CORRUPT");
  return counts;
}
