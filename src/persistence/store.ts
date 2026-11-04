import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { existsSync, mkdirSync, realpathSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { MIGRATE_V1_TO_V2, SCHEMA, SCHEMA_VERSION } from "./schema.js";
import { FileStore, json, digest, canonicalJson } from "./files.js";
import { AppError, check } from "../domain/errors.js";
import type { Draft, Message, NodeRun, ProviderSetting, Run, StreamEvent, Turn, Version, Workflow } from "../domain/types.js";

type Row = Record<string, unknown>;
const parsed = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : undefined as T;
export class Store {
  readonly db!: DatabaseSync;
  readonly files: FileStore;
  readonly root: string;
  readonly events = new EventEmitter();
  private depth = 0;
  private pendingEvents: StreamEvent[] = [];
  private lock: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.root = realpathSync(root);
    const old = join(homedir(), ".orchard");
    check(this.root !== resolve(old) && !(existsSync(old) && realpathSync(old) === this.root) && !existsSync(join(this.root, "orchard.db")), "OLD_DATA_DIRECTORY", "请使用新工作台独立的数据目录");
    this.files = new FileStore(this.root); this.lock = join(this.root, "workbench.lock");
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      let alive = true; try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      check(!alive && Number.isInteger(pid) && pid > 0, "INSTANCE_LOCKED", "此数据目录已有工作台实例");
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, "wx", 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd);
    const databasePath = this.files.path("workbench.db");
    try {
      this.db = new DatabaseSync(databasePath);
      const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
      const appId = Number(this.db.prepare("PRAGMA application_id").get()!.application_id);
      if (version === 0) {
        check(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0, "UNKNOWN_DATABASE", "拒绝初始化未知数据库");
        this.db.exec(`BEGIN; ${SCHEMA} COMMIT;`);
      } else {
        check([1, SCHEMA_VERSION].includes(version) && appId === 1331110449, "UNKNOWN_DATABASE", "不支持的工作台数据库版本");
        if (version === 1) {
          this.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
          try {
            this.db.exec(MIGRATE_V1_TO_V2);
            check(this.db.prepare("PRAGMA foreign_key_check").all().length === 0, "MIGRATION_FAILED", "数据库升级外键校验失败");
            this.db.exec("COMMIT;");
          } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
        }
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      rmSync(this.files.path("staging"), { force: true, recursive: true });
      this.recover();
    } catch (error) { this.db!?.close(); unlinkSync(this.lock); throw error; }
  }
  close() { this.db.close(); if (existsSync(this.lock)) unlinkSync(this.lock); }
  one<T = Row>(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).get(...params) as T | undefined; }
  all<T = Row>(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).all(...params) as T[]; }
  exec(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  transaction<T>(operation: () => T): T {
    const outer = this.depth === 0, savepoint = `s${this.depth}`, eventCount = this.pendingEvents.length;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`); this.depth++;
    let result: T;
    try {
      result = operation();
      this.db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`); this.depth--;
    } catch (error) {
      this.depth--; this.pendingEvents.length = eventCount;
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error;
    }
    if (outer) {
      const events = this.pendingEvents.splice(0);
      for (const event of events) {
        // A disconnected observer must never roll back an already committed command.
        for (const listener of this.events.rawListeners("event")) {
          try { listener.call(this.events, event); } catch { /* Subscription recovers from the persisted cursor. */ }
        }
      }
    }
    return result;
  }
  reference(value: unknown) {
    const text = json(value);
    check(Buffer.byteLength(text) <= 16 * 1024 * 1024, "OUTPUT_LIMIT", "结果超过 16 MiB");
    if (Buffer.byteLength(text) <= 32768) return json({ inline: value ?? null });
    const blob = this.files.writeBlob(value);
    this.exec("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?)", blob.id, blob.relativePath, blob.hash, blob.size, "application/json", Date.now());
    return json({ artifactId: blob.id });
  }
  dereference(ref: unknown): unknown {
    if (!ref) return undefined;
    const value = parsed<{ inline?: unknown; artifactId?: string }>(ref);
    if (Object.hasOwn(value, "inline")) return value.inline;
    const artifact = this.one("SELECT * FROM artifacts WHERE id=?", value.artifactId!);
    check(artifact, "ARTIFACT_MISSING", "产物记录不存在");
    return this.files.readBlob(String(artifact.relative_path), String(artifact.sha256), Number(artifact.byte_size));
  }
  command<T>(scope: string, requestId: string, input: unknown, operation: () => T): T {
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    const hash = digest(canonicalJson(input));
    return this.transaction(() => {
      const prior = this.one("SELECT * FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId);
      if (prior) {
        if (prior.request_hash !== hash) throw new AppError("REQUEST_CONFLICT", "同一请求标识已用于不同内容", 409);
        return parsed<T>(prior.result_json);
      }
      const result = operation();
      this.exec("INSERT INTO command_receipts VALUES(?,?,?,?,?)", scope, requestId, hash, json(result), Date.now());
      return result;
    });
  }
  append(type: "run" | "authoring_turn", id: string, eventType: string, payload: unknown, nodeId?: string, attemptId?: string) {
    return this.transaction(() => {
      check(this.one(`SELECT id FROM ${type === "run" ? "runs" : "authoring_turns"} WHERE id=?`, id), "NOT_FOUND", "事件流不存在");
      const sequence = Number(this.one("SELECT coalesce(max(sequence),0)+1 AS n FROM stream_events WHERE stream_type=? AND stream_id=?", type, id)!.n);
      const createdAt = Date.now();
      this.exec("INSERT INTO stream_events VALUES(?,?,?,?,?,?,?,?)", type, id, sequence, eventType, nodeId ?? null, attemptId ?? null, this.reference(payload), createdAt);
      const event: StreamEvent = { streamType: type, streamId: id, sequence, type: eventType, payload, createdAt, ...(nodeId ? { nodeId } : {}), ...(attemptId ? { attemptId } : {}) };
      this.pendingEvents.push(event); return event;
    });
  }
  stream(type: string, id: string, after = 0, limit = 500): StreamEvent[] {
    return this.all("SELECT * FROM stream_events WHERE stream_type=? AND stream_id=? AND sequence>? ORDER BY sequence LIMIT ?", type, id, after, limit).map(row => ({
      streamType: String(row.stream_type), streamId: String(row.stream_id), sequence: Number(row.sequence), type: String(row.event_type),
      payload: this.dereference(row.payload_ref), createdAt: Number(row.created_at),
      ...(row.node_id ? { nodeId: String(row.node_id) } : {}), ...(row.attempt_id ? { attemptId: String(row.attempt_id) } : {}),
    }));
  }
  lastSequence(type: string, id: string) { return Number(this.one("SELECT coalesce(max(sequence),0) AS n FROM stream_events WHERE stream_type=? AND stream_id=?", type, id)!.n); }
  provider(id: string): ProviderSetting | undefined {
    const r = this.one("SELECT * FROM provider_settings WHERE id=?", id);
    return r ? { id: String(r.id), enabled: !!r.enabled, config: parsed(r.config_json), models: parsed(r.models_json), defaultModel: String(r.default_model), revision: Number(r.revision), updatedAt: Number(r.updated_at) } : undefined;
  }
  saveProvider(setting: ProviderSetting) { this.exec("INSERT INTO provider_settings VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,config_json=excluded.config_json,models_json=excluded.models_json,default_model=excluded.default_model,revision=excluded.revision,updated_at=excluded.updated_at", setting.id, setting.enabled ? 1 : 0, json(setting.config), json(setting.models), setting.defaultModel, setting.revision, setting.updatedAt); }
  version(id: string): Version {
    const r = this.one("SELECT * FROM workflow_versions WHERE id=?", id); check(r, "NOT_FOUND", "版本不存在");
    return { id: String(r.id), workflowId: String(r.workflow_id), number: Number(r.version_no), definition: parsed(r.definition_json), layout: parsed(r.layout_json), artifactPath: String(r.artifact_path), contentHash: String(r.content_hash), createdAt: Number(r.created_at) };
  }
  workflows() { return this.all<{ id: string; name: string; currentVersionId: string; createdAt: number; updatedAt: number }>("SELECT id,name,current_version_id AS currentVersionId,created_at AS createdAt,updated_at AS updatedAt FROM workflows ORDER BY updated_at DESC"); }
  versions(workflowId: string) { return this.all<{ id: string }>("SELECT id FROM workflow_versions WHERE workflow_id=? ORDER BY version_no DESC", workflowId).map(r => this.version(r.id)); }
  workflowDraftIds(workflowId: string) {
    return this.all<{ id: string }>("SELECT id FROM drafts WHERE workflow_id=? OR base_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id=?) OR published_version_id IN (SELECT id FROM workflow_versions WHERE workflow_id=?)", workflowId, workflowId, workflowId).map(row => row.id);
  }
  private deleteContent(draftIds: string[], versionIds: string[]) {
    const runs = new Map<string, { id: string; status: string }>();
    for (const versionId of versionIds) for (const run of this.all<{ id: string; status: string }>("SELECT id,status FROM runs WHERE workflow_version_id=?", versionId)) runs.set(run.id, run);
    for (const draftId of draftIds) {
      const draft = this.draft(draftId);
      check(draft.status !== "publishing", "WORKFLOW_BUSY", "工作流正在发布，请完成后再删除");
      check(!this.turns(draftId).some(turn => turn.status === "running"), "WORKFLOW_BUSY", "工作流正在生成，请取消或完成后再删除");
      for (const run of this.all<{ id: string; status: string }>("SELECT id,status FROM runs WHERE draft_id=?", draftId)) runs.set(run.id, run);
    }
    check(![...runs.values()].some(run => ["queued", "running", "cancel_requested"].includes(run.status)), "WORKFLOW_BUSY", "工作流有排队或执行中的运行，请取消或完成后再删除");
    for (const run of runs.values()) {
      this.exec("DELETE FROM node_attempts WHERE node_run_id IN (SELECT id FROM node_runs WHERE run_id=?)", run.id);
      this.exec("DELETE FROM node_runs WHERE run_id=?", run.id);
      this.exec("DELETE FROM stream_events WHERE stream_type='run' AND stream_id=?", run.id);
      this.exec("DELETE FROM command_receipts WHERE json_extract(result_json,'$.id')=?", run.id);
      this.exec("DELETE FROM runs WHERE id=?", run.id);
    }
    for (const draftId of draftIds) {
      this.exec("DELETE FROM command_receipts WHERE json_extract(result_json,'$.id') IN (SELECT id FROM authoring_turns WHERE draft_id=?) OR scope IN (?,?,?)", draftId, `turn:${draftId}`, `publish:${draftId}`, `draft-run:${draftId}`);
      this.exec("DELETE FROM stream_events WHERE stream_type='authoring_turn' AND stream_id IN (SELECT id FROM authoring_turns WHERE draft_id=?)", draftId);
      this.exec("DELETE FROM authoring_messages WHERE draft_id=?", draftId);
      this.exec("DELETE FROM authoring_turns WHERE draft_id=?", draftId);
      this.exec("DELETE FROM command_receipts WHERE json_extract(result_json,'$.id')=?", draftId);
      this.exec("DELETE FROM drafts WHERE id=?", draftId);
    }
  }
  deleteWorkflow(id: string) {
    return this.transaction(() => {
      if (!this.one("SELECT id FROM workflows WHERE id=?", id)) return { id, deleted: true };
      const versions = this.all<{ id: string }>("SELECT id FROM workflow_versions WHERE workflow_id=?", id);
      this.deleteContent(this.workflowDraftIds(id), versions.map(version => version.id));
      this.exec("UPDATE workflows SET current_version_id=NULL WHERE id=?", id);
      for (const version of versions) this.exec("DELETE FROM command_receipts WHERE scope=? OR json_extract(result_json,'$.id')=?", `run:${version.id}`, version.id);
      this.exec("DELETE FROM command_receipts WHERE scope=?", `version-draft:${id}`);
      this.exec("DELETE FROM workflow_versions WHERE workflow_id=?", id);
      this.exec("DELETE FROM workflows WHERE id=?", id);
      return { id, deleted: true };
    });
  }
  deleteDraft(id: string) {
    return this.transaction(() => {
      if (!this.one("SELECT id FROM drafts WHERE id=?", id)) return { id, deleted: true };
      check(this.draft(id).status !== "published", "DRAFT_BUSY", "已发布草稿请通过工作流详情删除");
      this.deleteContent([id], []);
      return { id, deleted: true };
    });
  }
  draft(id: string): Draft {
    const r = this.one("SELECT * FROM drafts WHERE id=?", id); check(r, "NOT_FOUND", "草稿不存在");
    return { id: String(r.id), workflowId: r.workflow_id as string | null, baseVersionId: r.base_version_id as string | null, revision: Number(r.revision), artifactPath: String(r.artifact_path), validation: parsed(r.validation_json), publishedVersionId: r.published_version_id as string | null, status: String(r.status), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }
  drafts() { return this.all<{ id: string }>("SELECT id FROM drafts ORDER BY updated_at DESC").map(r => this.draft(r.id)); }
  turn(id: string): Turn {
    const r = this.one("SELECT * FROM authoring_turns WHERE id=?", id); check(r, "NOT_FOUND", "轮次不存在");
    return { id: String(r.id), draftId: String(r.draft_id), providerId: String(r.provider_id), modelId: String(r.model_id), providerRevision: Number(r.provider_revision), status: String(r.status), baseRevision: Number(r.base_revision), error: parsed(r.error_json), createdAt: Number(r.created_at), endedAt: r.ended_at as number | null };
  }
  turns(draftId: string) { return this.all<{ id: string }>("SELECT id FROM authoring_turns WHERE draft_id=? ORDER BY created_at", draftId).map(r => this.turn(r.id)); }
  message(draftId: string, turnId: string | null, role: string, content: unknown) {
    const id = randomUUID();
    const sequence = Number(this.one("SELECT coalesce(max(sequence),0)+1 AS n FROM authoring_messages WHERE draft_id=?", draftId)!.n);
    this.exec("INSERT INTO authoring_messages VALUES(?,?,?,?,?,?,?)", id, draftId, turnId, sequence, role, json(content), Date.now());
  }
  messages(draftId: string): Message[] { return this.all("SELECT * FROM authoring_messages WHERE draft_id=? ORDER BY sequence", draftId).map(r => ({ id: String(r.id), draftId, turnId: r.turn_id as string | null, sequence: Number(r.sequence), role: String(r.role), content: parsed(r.content_json), createdAt: Number(r.created_at) })); }
  run(id: string): Run {
    const r = this.one("SELECT * FROM runs WHERE id=?", id); check(r, "NOT_FOUND", "运行不存在");
    return { id: String(r.id), workflowVersionId: r.workflow_version_id as string | null, draftId: r.draft_id as string | null, draftRevision: r.draft_revision as number | null, snapshotPath: r.snapshot_path as string | null, status: r.status as Run["status"], input: this.dereference(r.input_ref), output: this.dereference(r.output_ref), activeNodeId: r.active_node_id as string | null, error: parsed(r.error_json), createdAt: Number(r.created_at), startedAt: r.started_at as number | null, endedAt: r.ended_at as number | null };
  }
  runs() { return this.all<{ id: string }>("SELECT id FROM runs ORDER BY created_at DESC LIMIT 200").map(r => this.run(r.id)); }
  nodes(runId: string): NodeRun[] {
    return this.all("SELECT * FROM node_runs WHERE run_id=? ORDER BY rowid", runId).map(r => ({
      id: String(r.id), runId, nodeId: String(r.node_id), type: r.type as NodeRun["type"], status: r.status as NodeRun["status"],
      input: this.dereference(r.input_ref), output: this.dereference(r.output_ref), route: parsed(r.route_json),
      skipReason: r.skip_reason as string | undefined, error: parsed(r.error_json), startedAt: r.started_at as number | null, endedAt: r.ended_at as number | null,
    }));
  }
  attempts(runId: string) { return this.all("SELECT a.* FROM node_attempts a JOIN node_runs n ON n.id=a.node_run_id WHERE n.run_id=? ORDER BY a.started_at", runId).map(r => ({ id: r.id, nodeRunId: r.node_run_id, status: r.status, execution: parsed(r.execution_json), input: this.dereference(r.input_ref), output: this.dereference(r.output_ref), error: parsed(r.error_json), startedAt: r.started_at, endedAt: r.ended_at })); }
  private recover() {
    this.transaction(() => {
      this.exec("UPDATE drafts SET status='draft' WHERE status='publishing'");
      for (const r of this.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('running','cancel_requested')")) {
        const error = json({ code: "RUN_INTERRUPTED", message: "服务退出中断了运行；外部副作用可能已发生，请检查后重新运行。" });
        this.exec("UPDATE runs SET status='interrupted',error_json=?,ended_at=?,active_node_id=NULL WHERE id=?", error, Date.now(), r.id);
        this.exec("UPDATE node_runs SET status='interrupted',error_json=?,ended_at=? WHERE run_id=? AND status='running'", error, Date.now(), r.id);
        this.exec("UPDATE node_attempts SET status='interrupted',error_json=?,ended_at=? WHERE node_run_id IN(SELECT id FROM node_runs WHERE run_id=?) AND status='running'", error, Date.now(), r.id);
        this.exec("UPDATE node_runs SET status='skipped',skip_reason='run_terminated',ended_at=? WHERE run_id=? AND status='pending'", Date.now(), r.id);
        this.append("run", r.id, "run.interrupted", parsed(error));
      }
      for (const r of this.all<{ id: string; draft_id: string }>("SELECT id,draft_id FROM authoring_turns WHERE status='running'")) {
        this.exec("UPDATE authoring_turns SET status='interrupted',ended_at=? WHERE id=?", Date.now(), r.id);
        this.message(r.draft_id, r.id, "error", { code: "TURN_INTERRUPTED", message: "服务重启中断了生成，已保留草稿。" });
        this.append("authoring_turn", r.id, "turn.interrupted", {});
      }
    });
  }
}
