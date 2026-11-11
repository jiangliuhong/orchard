import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { AGENT_RUNTIME_SCHEMA } from "./schema.js";

/** Approved database step only. The application migration registry must not activate this step
 * until the runtime cutover is complete. Production backup, file/journal reset and directory
 * single-writer/process recovery remain the migration runner's responsibility.
 */
export const AGENT_RESET_SOURCE_VERSION = 10;
export const AGENT_RESET_TARGET_VERSION = 11;
const legacy = ["agent_conversations", "authoring_turns", "authoring_messages"] as const;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }
interface Fingerprint { name: string; rows: number; digest: string }
export interface AgentResetPreview {
  sourceVersion: 10;
  targetVersion: 11;
  confirmationToken: string;
  conversations: number;
  turns: number;
  messages: number;
  authoringEvents: number;
  receiptScopes: string[];
  preservedTables: Fingerprint[];
  /** Database preview is not proof of filesystem/process ownership. */
  filesystemResetRequired: true;
}

function objects(db: DatabaseSync): SchemaObject[] {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all() as unknown as SchemaObject[];
}
function fingerprint(db: DatabaseSync, table: string, where = ""): Fingerprint {
  const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as unknown as { name: string; pk: number }[];
  const keys = columns.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => quote(column.name));
  const hash = createHash("sha256"); let rows = 0;
  for (const row of db.prepare(`SELECT * FROM ${quote(table)} ${where} ORDER BY ${keys.length ? keys.join(",") : "rowid"}`).iterate()) {
    const content = canonicalJson(row); hash.update(String(Buffer.byteLength(content))); hash.update(":"); hash.update(content); rows++;
  }
  return { name: table, rows, digest: hash.digest("hex") };
}
function count(db: DatabaseSync, table: string, where = ""): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${quote(table)} ${where}`).get()!.n);
}
function validateLegacy(db: DatabaseSync): SchemaObject[] {
  check(Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys) === 1, "AGENT_RESET_FOREIGN_KEYS_REQUIRED", "重置必须启用外键检查");
  check(Number(db.prepare("PRAGMA user_version").get()!.user_version) === AGENT_RESET_SOURCE_VERSION, "AGENT_RESET_VERSION_UNSUPPORTED", "Agent 重置只适用于审核的 v10 基线", 409);
  const schema = objects(db), tables = schema.filter(item => item.type === "table");
  for (const name of legacy) check(tables.some(item => item.name === name), "AGENT_RESET_SCHEMA_MISMATCH", "缺少审核的旧 Agent 表", 409);
  check(!schema.some(item => item.name.startsWith("agent_") && !legacy.includes(item.name as typeof legacy[number]) && item.type === "table" && ["agent_turns", "agent_events", "agent_operations", "agent_backends", "agent_host_feedback", "agent_workspaces", "agent_runtime_resources", "agent_knowledge_installation"].includes(item.name)), "AGENT_RESET_SCHEMA_MISMATCH", "数据库混有新旧 Agent 结构，不能自动重置", 409);
  check(db.prepare("PRAGMA foreign_key_check").all().length === 0, "AGENT_RESET_FOREIGN_KEYS_INVALID", "数据库已有外键错误，禁止重置");
  for (const table of tables) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all()) {
      if (legacy.includes(String(fk.table) as typeof legacy[number])) check(legacy.includes(table.name as typeof legacy[number]), "AGENT_RESET_UNREVIEWED_DEPENDENCY", "业务表新增了旧对话/轮次外键，须重新审核", 409);
    }
  }
  for (const object of schema) {
    if (["view", "trigger"].includes(object.type) && /\b(agent_conversations|authoring_turns|authoring_messages)\b/i.test(object.sql ?? "")) {
      check(false, "AGENT_RESET_UNREVIEWED_DEPENDENCY", "视图或触发器依赖旧 Agent 结构，须重新审核", 409);
    }
  }
  check(!db.prepare("SELECT id FROM authoring_turns WHERE status IN ('queued','running','cancel_requested') OR submission_state IN ('sending','accepted') LIMIT 1").get(), "AGENT_RESET_TURN_ACTIVE", "旧 Agent 仍有活动或发送状态不确定的任务", 409);
  return schema;
}
function receiptScopes(db: DatabaseSync): string[] {
  const drafts = new Set(db.prepare("SELECT id FROM drafts").all().map(row => String(row.id)));
  const scripts = new Set(db.prepare("SELECT id FROM scripts").all().map(row => String(row.id)));
  const result: string[] = [];
  for (const row of db.prepare("SELECT DISTINCT scope FROM command_receipts ORDER BY scope").all()) {
    const scope = String(row.scope);
    const match = /^(turn|conversation|script-agent-confirm|script-agent-apply):(.+)$/.exec(scope);
    if (!match) continue;
    check((match[1]!.startsWith("script-agent-") ? scripts : drafts).has(match[2]!), "AGENT_RESET_UNREVIEWED_RECEIPT", "旧 Agent 幂等记录无法按现有资产确认归属，须核对后重试", 409);
    result.push(scope);
  }
  return result;
}
function preserved(db: DatabaseSync, schema: SchemaObject[], scopes: string[]): Fingerprint[] {
  const result: Fingerprint[] = [];
  for (const table of schema.filter(item => item.type === "table" && !legacy.includes(item.name as typeof legacy[number]))) {
    if (table.name === "stream_events") result.push(fingerprint(db, table.name, "WHERE stream_type!='authoring_turn'"));
    else if (table.name === "command_receipts") {
      // Filter in JS with exact scopes, never a broad LIKE/prefix deletion.
      const allowed = new Set(scopes), hash = createHash("sha256"); let rows = 0;
      for (const row of db.prepare("SELECT * FROM command_receipts ORDER BY scope,request_id").iterate()) {
        if (allowed.has(String(row.scope))) continue;
        const content = canonicalJson(row); hash.update(String(Buffer.byteLength(content))); hash.update(":"); hash.update(content); rows++;
      }
      result.push({ name: table.name, rows, digest: hash.digest("hex") });
    } else result.push(fingerprint(db, table.name));
  }
  return result;
}
export function previewLegacyAgentReset(db: DatabaseSync): AgentResetPreview {
  const schema = validateLegacy(db), scopes = receiptScopes(db);
  const allRows = schema.filter(item => item.type === "table").map(table => fingerprint(db, table.name));
  return {
    sourceVersion: AGENT_RESET_SOURCE_VERSION, targetVersion: AGENT_RESET_TARGET_VERSION,
    confirmationToken: digest(canonicalJson({ schema, allRows, scopes, approvedSchema: digest(AGENT_RUNTIME_SCHEMA) })),
    conversations: count(db, "agent_conversations"), turns: count(db, "authoring_turns"), messages: count(db, "authoring_messages"),
    authoringEvents: count(db, "stream_events", "WHERE stream_type='authoring_turn'"), receiptScopes: scopes,
    preservedTables: preserved(db, schema, scopes), filesystemResetRequired: true,
  };
}

/** Internal runner step, not an API. confirmationToken comes from a user-confirmed preview;
 * assertQuiesced must synchronously assert the held directory lease and confirmed old-process
 * shutdown (including script/web-bridge file-journal tasks, not just SQLite turns).
 * A throw or async/Promise result blocks BEFORE any mutation. No filesystem deletion here.
 */
export function applyLegacyAgentDatabaseReset(db: DatabaseSync, preview: AgentResetPreview, authorization: {
  confirmationToken: string;
  assertQuiesced(): void;
}): void {
  check(authorization.confirmationToken === preview.confirmationToken, "AGENT_RESET_CONFIRMATION_REQUIRED", "必须明确确认当前破坏性重置预览", 409);
  check(authorization.assertQuiesced() === undefined, "AGENT_RESET_PROCESS_UNCONFIRMED", "停止证明必须在进入事务前完成", 409);
  const savepoint = `agent_reset_${crypto.randomUUID().replaceAll("-", "")}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  try {
    const current = previewLegacyAgentReset(db);
    check(current.confirmationToken === preview.confirmationToken && canonicalJson(current) === canonicalJson(preview), "AGENT_RESET_PREVIEW_STALE", "数据库已变化，必须重新预览并确认", 409);
    db.exec("UPDATE agent_conversations SET rebuild_from_id=NULL; DELETE FROM authoring_messages; DELETE FROM authoring_turns; DELETE FROM agent_conversations;");
    db.exec("DELETE FROM stream_events WHERE stream_type='authoring_turn';");
    const removeReceipt = db.prepare("DELETE FROM command_receipts WHERE scope=?");
    for (const scope of current.receiptScopes) removeReceipt.run(scope);
    db.exec("DROP TABLE authoring_messages; DROP TABLE authoring_turns; DROP TABLE agent_conversations;");
    db.exec(AGENT_RUNTIME_SCHEMA);
    check(db.prepare("PRAGMA foreign_key_check").all().length === 0, "AGENT_RESET_FOREIGN_KEYS_INVALID", "重置后外键验证失败");
    const after = preserved(db, objects(db).filter(item => current.preservedTables.some(table => table.name === item.name)), current.receiptScopes);
    check(canonicalJson(after) === canonicalJson(current.preservedTables), "AGENT_RESET_BUSINESS_CHANGED", "业务数据映射验证失败，回滚重置");
    db.exec(`PRAGMA user_version=${AGENT_RESET_TARGET_VERSION}; RELEASE ${savepoint}`);
  } catch (error) { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
}
