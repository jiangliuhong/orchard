import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, join } from "node:path";
import { constants, copyFileSync, chmodSync, existsSync, fsyncSync, mkdirSync, realpathSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { MIGRATE_V1_TO_V2, MIGRATE_V2_TO_V3, MIGRATE_V3_TO_V4, SCHEMA, SCHEMA_VERSION } from "./schema.js";
import { FileStore, json, digest, canonicalJson } from "./files.js";
import { AppError, check } from "../domain/errors.js";
import type { AuthoringTurnStatus, BackendRef, ConversationMode, ConversationView, ContextMode, ConversationStatus, Draft, Message, NodeRun, ProviderSetting, Run, StreamEvent, SubmissionState, Turn, Version, Workflow } from "../domain/types.js";
import { ACTIVE_TURN_STATUSES, assertSubmissionState, assertTurnStatus, assertTurnTransition, isActiveTurn } from "../domain/turns.js";
export { ACTIVE_TURN_STATUSES };

/** 对话持久化记录（§11）：公开视图不含 backendRef，内部决策使用完整记录。 */
export interface ConversationRecord {
  id: string;
  draftId: string;
  mode: ConversationMode;
  contextMode: ContextMode;
  status: ConversationStatus;
  providerId: string;
  providerRevision: number;
  modelId: string;
  transport: "legacy" | "native";
  connectionFingerprint: string;
  cliVersion: string | null;
  backendRef: BackendRef | null;
  backendGeneration: number;
  syncedRevision: number | null;
  rebuildFromId: string | null;
  title: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

type Row = Record<string, unknown>;
const parsed = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : undefined as T;
export class Store {
  readonly db!: DatabaseSync;
  /** 自动升级前的完整数据库备份；不含认证或用户配置。 */
  readonly migrationBackupPath?: string;
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
        // §20.3：接受所有受支持旧版本（1、2、3），顺序执行增量迁移至当前版本。
        check([1, 2, 3, SCHEMA_VERSION].includes(version) && appId === 1331110449, "UNKNOWN_DATABASE", "不支持的工作台数据库版本");
        if (version < SCHEMA_VERSION) {
          // 服务尚未启动且已持有独占数据目录锁。先完成 WAL checkpoint，关闭连接后
          // 再复制主文件，绝不复制正在写入的 WAL 数据库。备份失败则拒绝迁移。
          const checkpoint = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;
          check(Number(checkpoint.busy) === 0, "MIGRATION_BACKUP_FAILED", "数据库正被其他连接占用，无法安全备份");
          this.db.close();
          const directory = this.files.path("backups");
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          const backup = this.files.path(`backups/workbench-v${version}-${randomUUID()}.db`);
          copyFileSync(databasePath, backup, constants.COPYFILE_EXCL);
          chmodSync(backup, 0o600);
          const fd = openSync(backup, "r");
          try { fsyncSync(fd); } finally { closeSync(fd); }
          const snapshot = new DatabaseSync(backup, { readOnly: true });
          try {
            check(snapshot.prepare("PRAGMA quick_check").get()!.quick_check === "ok"
              && Number(snapshot.prepare("PRAGMA user_version").get()!.user_version) === version,
            "MIGRATION_BACKUP_FAILED", "数据库备份完整性校验失败");
          } finally { snapshot.close(); }
          this.migrationBackupPath = backup;
          this.db = new DatabaseSync(databasePath);
          this.db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;");
          try {
            // 升级期间不丢失旧行；终态恢复在迁移提交后独立执行。
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            const counts = tables.map(row => {
              const name = String(row.name).replaceAll('"', '""');
              return { name, count: this.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n };
            });
            if (version === 1) this.db.exec(MIGRATE_V1_TO_V2);
            if (version <= 2) this.db.exec(MIGRATE_V2_TO_V3);
            if (version <= 3) this.db.exec(MIGRATE_V3_TO_V4);
            check(this.db.prepare("PRAGMA foreign_key_check").all().length === 0, "MIGRATION_FAILED", "数据库升级外键校验失败");
            for (const { name, count } of counts) {
              check(this.db.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n === count,
                "MIGRATION_FAILED", "数据库升级行数校验失败");
            }
            this.db.exec("COMMIT;");
          } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
        }
      }
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      rmSync(this.files.path("staging"), { force: true, recursive: true });
      this.recover();
    } catch (error) { if (this.db?.isOpen) this.db.close(); unlinkSync(this.lock); throw error; }
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
      check(!this.turns(draftId).some(turn => (ACTIVE_TURN_STATUSES as readonly string[]).includes(turn.status)), "WORKFLOW_BUSY", "工作流正在生成，请取消或完成后再删除");
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
      this.exec("DELETE FROM command_receipts WHERE json_extract(result_json,'$.id') IN (SELECT id FROM authoring_turns WHERE draft_id=?) OR scope IN (?,?,?,?)", draftId, `turn:${draftId}`, `publish:${draftId}`, `draft-run:${draftId}`, `conversation:${draftId}`);
      this.exec("DELETE FROM stream_events WHERE stream_type='authoring_turn' AND stream_id IN (SELECT id FROM authoring_turns WHERE draft_id=?)", draftId);
      this.exec("DELETE FROM authoring_messages WHERE draft_id=?", draftId);
      this.exec("DELETE FROM authoring_turns WHERE draft_id=?", draftId);
      // §20.2 删除顺序：先清理会话自引用，再删会话，最后删草稿。
      this.exec("UPDATE agent_conversations SET rebuild_from_id=NULL WHERE draft_id=?", draftId);
      this.exec("DELETE FROM agent_conversations WHERE draft_id=?", draftId);
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
    return {
      id: String(r.id), draftId: String(r.draft_id), providerId: String(r.provider_id), modelId: String(r.model_id), providerRevision: Number(r.provider_revision),
      status: String(r.status), baseRevision: Number(r.base_revision), error: parsed(r.error_json), createdAt: Number(r.created_at), endedAt: r.ended_at as number | null,
      conversationId: (r.conversation_id as string | null) ?? null,
      backendTurnId: (r.backend_turn_id as string | null) ?? null,
      connectionGeneration: r.connection_generation === null || r.connection_generation === undefined ? null : Number(r.connection_generation),
      submissionState: (r.submission_state as SubmissionState) ?? "not_sent",
    };
  }
  turns(draftId: string) { return this.all<{ id: string }>("SELECT id FROM authoring_turns WHERE draft_id=? ORDER BY created_at", draftId).map(r => this.turn(r.id)); }
  turnsOfConversation(conversationId: string) { return this.all<{ id: string }>("SELECT id FROM authoring_turns WHERE conversation_id=? ORDER BY created_at", conversationId).map(r => this.turn(r.id)); }
  /** 新轮次必须通过此方法检查草稿、对话归属；迁移保留旧 NULL 关联。 */
  insertTurn(input: { id: string; draftId: string; providerId: string; modelId: string; providerRevision: number; baseRevision: number; conversationId?: string | null; status?: AuthoringTurnStatus; createdAt?: number }): Turn {
    const status = input.status ?? "queued", conversationId = input.conversationId ?? null;
    assertTurnStatus(status);
    if (conversationId !== null) {
      const conversation = this.conversation(conversationId);
      check(conversation?.draftId === input.draftId, "CONVERSATION_CONFLICT", "会话不属于该草稿", 409);
      check(conversation.providerId === input.providerId && conversation.modelId === input.modelId, "CONVERSATION_CONFLICT", "模型与会话快照不一致", 409);
    }
    this.exec("INSERT INTO authoring_turns(id,draft_id,provider_id,model_id,provider_revision,status,base_revision,conversation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      input.id, input.draftId, input.providerId, input.modelId, input.providerRevision, status, input.baseRevision, conversationId, input.createdAt ?? Date.now());
    return this.turn(input.id);
  }
  /** §19.2：合法状态校验 + 带当前状态条件的 UPDATE；终态不可再次修改。 */
  transitionTurn(id: string, expected: readonly string[], patch: { status?: string; submissionState?: SubmissionState; backendTurnId?: string | null; connectionGeneration?: number; error?: unknown; end?: boolean }): boolean {
    expected.forEach(assertTurnStatus);
    if (patch.status !== undefined) assertTurnStatus(patch.status);
    if (patch.submissionState !== undefined) assertSubmissionState(patch.submissionState);
    if (patch.connectionGeneration !== undefined) check(Number.isSafeInteger(patch.connectionGeneration) && patch.connectionGeneration >= 0, "INVALID_GENERATION", "连接代次无效");
    const current = this.turn(id);
    if (!expected.includes(current.status) || !isActiveTurn(current.status)) return false;
    assertTurnStatus(current.status);
    if (patch.status !== undefined && patch.status !== current.status) assertTurnTransition(current.status, patch.status as AuthoringTurnStatus);
    if (patch.submissionState !== undefined) {
      const order = ["not_sent", "sending", "accepted", "settled"];
      check(order.indexOf(patch.submissionState) >= order.indexOf(current.submissionState ?? "not_sent"), "INVALID_SUBMISSION_STATE", "提交状态不能回退");
    }
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    if (patch.status !== undefined) { assignments.push("status=?"); values.push(patch.status); }
    if (patch.submissionState !== undefined) { assignments.push("submission_state=?"); values.push(patch.submissionState); }
    if (patch.backendTurnId !== undefined) { assignments.push("backend_turn_id=?"); values.push(patch.backendTurnId); }
    if (patch.connectionGeneration !== undefined) { assignments.push("connection_generation=?"); values.push(patch.connectionGeneration); }
    if (patch.error !== undefined) { assignments.push("error_json=?"); values.push(patch.error === null ? null : json(patch.error)); }
    if (patch.end) { assignments.push("ended_at=?"); values.push(Date.now()); }
    check(assignments.length > 0, "INVALID_ARGUMENT", "状态更新不能为空");
    const placeholders = expected.map(() => "?").join(",");
    const result = this.exec(`UPDATE authoring_turns SET ${assignments.join(",")} WHERE id=? AND status IN (${placeholders})`, ...values, id, ...expected);
    return Number(result.changes) === 1;
  }
  message(draftId: string, turnId: string | null, role: string, content: unknown, conversationId: string | null = null) {
    // §20.2：跨表同属草稿强制校验；保留旧 null 关联。
    if (conversationId !== null) {
      const conversation = this.one("SELECT draft_id FROM agent_conversations WHERE id=?", conversationId);
      check(conversation && String(conversation.draft_id) === draftId, "CONVERSATION_CONFLICT", "会话不属于该草稿");
    }
    if (turnId !== null) {
      const turn = this.one("SELECT conversation_id FROM authoring_turns WHERE id=? AND draft_id=?", turnId, draftId);
      check(turn, "NOT_FOUND", "轮次不存在");
      check((turn.conversation_id as string | null) === conversationId, "CONVERSATION_CONFLICT", "消息会话与轮次会话不一致");
    }
    const id = randomUUID();
    const sequence = Number(this.one("SELECT coalesce(max(sequence),0)+1 AS n FROM authoring_messages WHERE draft_id=?", draftId)!.n);
    this.exec("INSERT INTO authoring_messages(id,draft_id,turn_id,sequence,role,content_json,created_at,conversation_id) VALUES(?,?,?,?,?,?,?,?)", id, draftId, turnId, sequence, role, json(content), Date.now(), conversationId);
  }
  messages(draftId: string, conversationId?: string | null): Message[] {
    // undefined → 全量（旧客户端语义）；null → 旧版历史；字符串 → 指定会话。
    const filter = conversationId === undefined ? "" : conversationId === null ? " AND conversation_id IS NULL" : " AND conversation_id=?";
    const params = conversationId === undefined || conversationId === null ? [draftId] : [draftId, conversationId];
    return this.all(`SELECT * FROM authoring_messages WHERE draft_id=?${filter} ORDER BY sequence`, ...params as SQLInputValue[]).map(r => ({
      id: String(r.id), draftId, turnId: r.turn_id as string | null, sequence: Number(r.sequence), role: String(r.role), content: parsed(r.content_json), createdAt: Number(r.created_at),
      conversationId: (r.conversation_id as string | null) ?? null,
    }));
  }
  conversation(id: string): ConversationRecord | undefined {
    const r = this.one("SELECT * FROM agent_conversations WHERE id=?", id);
    return r ? this.mapConversation(r) : undefined;
  }
  conversations(draftId: string): ConversationRecord[] {
    return this.all("SELECT * FROM agent_conversations WHERE draft_id=? ORDER BY created_at,id", draftId).map(r => this.mapConversation(r));
  }
  currentConversation(draftId: string): ConversationRecord | undefined {
    const r = this.one("SELECT * FROM agent_conversations WHERE draft_id=? AND status='current' ORDER BY created_at DESC LIMIT 1", draftId);
    return r ? this.mapConversation(r) : undefined;
  }
  private mapConversation(r: Row): ConversationRecord {
    return {
      id: String(r.id), draftId: String(r.draft_id), mode: String(r.mode) as ConversationMode, contextMode: String(r.context_mode) as ContextMode,
      status: String(r.status) as ConversationStatus, providerId: String(r.provider_id), providerRevision: Number(r.provider_revision),
      modelId: String(r.model_id), transport: String(r.transport) as "legacy" | "native", connectionFingerprint: String(r.connection_fingerprint),
      cliVersion: (r.cli_version as string | null) ?? null, backendRef: parsed<BackendRef>(r.backend_ref_json) ?? null,
      backendGeneration: Number(r.backend_generation ?? 0), syncedRevision: r.synced_revision === null || r.synced_revision === undefined ? null : Number(r.synced_revision),
      rebuildFromId: (r.rebuild_from_id as string | null) ?? null, title: (r.title as string | null) ?? null,
      archivedAt: r.archived_at === null || r.archived_at === undefined ? null : Number(r.archived_at),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
      lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : Number(r.last_used_at),
    };
  }
  /** 插入新对话；不处理轮换（由调用方在同一事务内先 demoteCurrentConversation）。 */
  insertConversation(record: Omit<ConversationRecord, "updatedAt"> & { updatedAt?: number }): void {
    const now = record.updatedAt ?? Date.now();
    check(this.one("SELECT id FROM drafts WHERE id=?", record.draftId), "NOT_FOUND", "草稿不存在");
    if (record.rebuildFromId !== null) check(this.conversation(record.rebuildFromId)?.draftId === record.draftId,
      "CONVERSATION_CONFLICT", "重建来源不属于该草稿", 409);
    if (record.backendRef !== null) this.validateBackendRef(record.backendRef);
    this.exec(
      "INSERT INTO agent_conversations(id,draft_id,mode,context_mode,status,provider_id,provider_revision,model_id,transport,connection_fingerprint,cli_version,backend_ref_json,backend_generation,synced_revision,rebuild_from_id,title,archived_at,created_at,updated_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      record.id, record.draftId, record.mode, record.contextMode, record.status, record.providerId, record.providerRevision, record.modelId,
      record.transport, record.connectionFingerprint, record.cliVersion, record.backendRef === null ? null : json(record.backendRef),
      record.backendGeneration, record.syncedRevision, record.rebuildFromId, record.title, record.archivedAt, record.createdAt, now, record.lastUsedAt,
    );
  }
  /** 轮换：将当前对话转为 idle 历史状态；needs_rebuild 诊断历史不受影响。返回受影响行数。 */
  demoteCurrentConversation(draftId: string): number {
    return Number(this.exec("UPDATE agent_conversations SET status='idle',updated_at=? WHERE draft_id=? AND status='current'", Date.now(), draftId).changes);
  }
  markConversation(id: string, status: "needs_rebuild"): boolean {
    return Number(this.exec("UPDATE agent_conversations SET status=?,updated_at=? WHERE id=? AND status='current'", status, Date.now(), id).changes) === 1;
  }
  /** idle → current 继续；原 current（若存在）先转为 idle，由唯一索引保证至多一个 current。 */
  resumeConversation(draftId: string, id: string): ConversationRecord {
    const target = this.conversation(id);
    check(target !== undefined && target.draftId === draftId, "NOT_FOUND", "会话不属于该草稿", 404);
    check(target.status === "idle", "CONVERSATION_CONFLICT", "仅可继续 idle 状态的历史对话", 409);
    this.demoteCurrentConversation(draftId);
    const changed = Number(this.exec("UPDATE agent_conversations SET status='current',updated_at=? WHERE id=? AND draft_id=? AND status='idle'", Date.now(), id, draftId).changes);
    check(changed === 1, "CONVERSATION_CONFLICT", "仅可继续 idle 状态的历史对话", 409);
    return this.conversation(id)!;
  }
  /** current/idle → archived（用户主动归档）；消息、轮次与审计数据保留。 */
  archiveConversation(draftId: string, id: string): ConversationRecord {
    const now = Date.now();
    const changed = Number(this.exec("UPDATE agent_conversations SET status='archived',archived_at=?,updated_at=? WHERE id=? AND draft_id=? AND status IN ('current','idle')", now, now, id, draftId).changes);
    check(changed === 1, "CONVERSATION_CONFLICT", "仅可归档当前或历史对话", 409);
    return this.conversation(id)!;
  }
  /** archived → current 恢复；原 current（若存在）转为 idle；archived_at 保留作审计。 */
  restoreConversation(draftId: string, id: string): ConversationRecord {
    const target = this.conversation(id);
    check(target !== undefined && target.draftId === draftId, "NOT_FOUND", "会话不属于该草稿", 404);
    check(target.status === "archived", "CONVERSATION_CONFLICT", "仅可恢复已归档对话", 409);
    this.demoteCurrentConversation(draftId);
    const changed = Number(this.exec("UPDATE agent_conversations SET status='current',updated_at=? WHERE id=? AND draft_id=? AND status='archived'", Date.now(), id, draftId).changes);
    check(changed === 1, "CONVERSATION_CONFLICT", "仅可恢复已归档对话", 409);
    return this.conversation(id)!;
  }
  renameConversation(draftId: string, id: string, title: string): ConversationRecord {
    const trimmed = title.trim();
    check(trimmed.length > 0 && trimmed.length <= 200, "INVALID_TITLE", "标题长度须在 1 到 200 字符之间");
    const changed = Number(this.exec("UPDATE agent_conversations SET title=?,updated_at=? WHERE id=? AND draft_id=?", trimmed, Date.now(), id, draftId).changes);
    check(changed === 1, "NOT_FOUND", "会话不存在", 404);
    return this.conversation(id)!;
  }
  /** 首条用户消息落库时回填确定性标题；用户已命名（或已回填）则不覆盖。 */
  setTitleIfUnset(id: string, title: string): void {
    this.exec("UPDATE agent_conversations SET title=? WHERE id=? AND title IS NULL", title, id);
  }
  /** 对话首条/最后一条用户消息文本（用于标题推导与列表摘要）；无则 null。 */
  userMessageText(conversationId: string, position: "first" | "last"): string | null {
    const order = position === "first" ? "ASC" : "DESC";
    const row = this.one(`SELECT content_json FROM authoring_messages WHERE conversation_id=? AND role='user' ORDER BY sequence ${order} LIMIT 1`, conversationId);
    if (!row) return null;
    const content = parsed<{ text?: unknown }>(row.content_json);
    return typeof content?.text === "string" ? content.text : null;
  }
  /** 对话最后一条轮次状态；无轮次则 null。 */
  lastTurnStatus(conversationId: string): string | null {
    const row = this.one("SELECT status FROM authoring_turns WHERE conversation_id=? ORDER BY created_at DESC, id DESC LIMIT 1", conversationId);
    return row ? String(row.status) : null;
  }
  /** 草稿当前活动轮次（queued/running/cancel_requested）；无则 null。 */
  activeTurnId(draftId: string): string | null {
    const row = this.one("SELECT id FROM authoring_turns WHERE draft_id=? AND status IN ('queued','running','cancel_requested') LIMIT 1", draftId);
    return row ? String(row.id) : null;
  }
  /** 显式列举公开字段，后端 ID / 文件路径 / 连接指纹不出现在 API DTO。 */
  conversationView(id: string, connectionState: ConversationView["connectionState"] = "absent"): ConversationView {
    const row = this.conversation(id);
    check(row, "NOT_FOUND", "会话不存在", 404);
    const { draftId, mode, contextMode, status, providerId, providerRevision, modelId, transport, cliVersion,
      syncedRevision, rebuildFromId, title, archivedAt, createdAt, updatedAt, lastUsedAt } = row;
    return { id, draftId, mode, contextMode, status, providerId, providerRevision, modelId, transport, cliVersion,
      syncedRevision, rebuildFromId, createdAt, updatedAt, lastUsedAt, connectionState,
      title, archivedAt, lastUserMessage: null, lastTurnStatus: null, activeTurnId: null };
  }
  private validateBackendRef(ref: BackendRef): void {
    check(ref.version === 1 && (ref.kind === "codex" || ref.kind === "pi"), "INVALID_BACKEND_REF", "后端引用类型或版本无效");
    check(typeof ref.cwd === "string" && isAbsolute(ref.cwd) && !ref.cwd.includes("\0"), "INVALID_BACKEND_REF", "后端工作目录无效");
    const id = ref.kind === "codex" ? ref.threadId : ref.sessionId;
    check(typeof id === "string" && id.length > 0 && !id.includes("\0"), "INVALID_BACKEND_REF", "后端会话标识无效");
    if (ref.kind === "pi") {
      check(typeof ref.sessionFile === "string" && isAbsolute(ref.sessionFile) && !ref.sessionFile.includes("\0"), "INVALID_BACKEND_REF", "Pi 会话文件引用无效");
      // 允许首轮前的预分配（不存在）文件；检查所有已存在祖先，拒绝 symlink。
      const path = relative(this.root, ref.sessionFile);
      check(path.startsWith("agent-sessions/pi/"), "INVALID_BACKEND_REF", "Pi 会话文件超出宿主管理目录");
      this.files.path(path);
    }
  }
  /** 获得后尽快持久化；拒绝旧代次覆盖新引用或修改已归档/需重建的会话。 */
  saveBackendRef(id: string, ref: BackendRef | null, generation: number): boolean {
    check(Number.isSafeInteger(generation) && generation >= 0, "INVALID_GENERATION", "连接代次无效");
    if (ref !== null) this.validateBackendRef(ref);
    return Number(this.exec("UPDATE agent_conversations SET backend_ref_json=?,backend_generation=?,updated_at=? WHERE id=? AND status='current' AND backend_generation<=?",
      ref === null ? null : json(ref), generation, Date.now(), id, generation).changes) === 1;
  }
  touchConversation(id: string, syncedRevision?: number): void {
    const now = Date.now();
    check(syncedRevision === undefined || Number.isSafeInteger(syncedRevision) && syncedRevision >= 0, "INVALID_REVISION", "同步修订号无效");
    this.exec("UPDATE agent_conversations SET last_used_at=?,updated_at=?" + (syncedRevision === undefined ? "" : ",synced_revision=?") + " WHERE id=?",
      ...(syncedRevision === undefined ? [now, now, id] : [now, now, syncedRevision, id]));
  }
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
      // §19.4 保守恢复：所有未结束轮次变为 interrupted，绝不重发；
      // sending/accepted 且无 settled 边界的会话标 needs_rebuild（not_sent 的会话可继续）。
      for (const r of this.all<{ id: string; draft_id: string; submission_state: string; conversation_id: string | null }>("SELECT id,draft_id,submission_state,conversation_id FROM authoring_turns WHERE status IN ('queued','running','cancel_requested')")) {
        const error = { code: "TURN_INTERRUPTED", message: "服务重启中断了生成，已保留草稿，不会自动重新调用模型。" };
        if (!this.transitionTurn(r.id, ACTIVE_TURN_STATUSES, { status: "interrupted", error, end: true })) continue;
        this.message(r.draft_id, r.id, "error", error, r.conversation_id);
        this.append("authoring_turn", r.id, "turn.interrupted", { ...error, conversationId: r.conversation_id });
        if (r.conversation_id !== null && (r.submission_state === "sending" || r.submission_state === "accepted")) {
          this.exec("UPDATE agent_conversations SET status='needs_rebuild',updated_at=? WHERE id=? AND status='current'", Date.now(), r.conversation_id);
        }
      }
    });
  }
}
