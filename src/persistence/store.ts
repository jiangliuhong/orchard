import { CommandHmac, sensitiveRequestDigest } from "../secrets/command-hmac.js";
import { KeyringStore, resolveKeyringPath } from "../secrets/keyring.js";
import { captureScriptInput, normalizeScriptInputSources, stripReferencedInput, type ScriptInputSources } from "../domain/script-test-input.js";
import type { HistorySources } from "../web-bridge/history-policy.js";
import type { DictionaryRequirement } from "../domain/dictionaries.js";
import { workflowDictionaryRequirements, workflowDictionarySensitivity } from "../domain/dictionaries.js";
import { DictionaryExecution, REDACTED, isRedacted, safeExecutionFailure, scriptDictionaryRequirements } from "../dictionaries/execution.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";
import { constants, copyFileSync, chmodSync, existsSync, fsyncSync, mkdirSync, realpathSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync, rmSync, renameSync, lstatSync } from "node:fs";
import { EventEmitter } from "node:events";
import { SCHEMA_VERSION } from "./schema.js";
import { DirectoryLease } from "../migrations/lock.js";
import { safe, present } from "../migrations/journal.js";
import { FileStore, json, digest, canonicalJson } from "./files.js";
import { AppError, check } from "../domain/errors.js";
import type { AuthoringTurnStatus, BackendRef, ConversationMode, ConversationView, ContextMode, ConversationStatus, Draft, Message, NodeRun, ProviderSetting, Run, RunSummary, ScriptVersion, ScriptView, StreamEvent, SubmissionState, Turn, Version, Workflow } from "../domain/types.js";
import { validateScript, type ScriptDefinition } from "../domain/scripts.js";
import { schemaSubset, bindingSchema } from "../domain/schema-compatibility.js";
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
  transport: "native";
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
/** 事务外准备、事务内登记的引用描述（§5.2）；不含可变外部路径。 */
export type PreparedReference =
  | { kind: "inline"; value: unknown }
  | { kind: "blob"; artifactId: string; relativePath: string; sha256: string; byteSize: number };
export class Store {
  readonly db!: DatabaseSync;
  readonly files: FileStore;
  readonly root: string;
  readonly events = new EventEmitter();
  private depth = 0;
  private pendingEvents: StreamEvent[] = [];
  constructor(root: string, lease: DirectoryLease) {
    this.root = realpathSync(root); DirectoryLease.validate(lease, this.root);
    check(present(safe(this.root, "workbench.db")), "UNKNOWN_DATABASE", "数据库不存在，须由 Bootstrap 初始化");
    this.db = new DatabaseSync(safe(this.root, "workbench.db"), { open: true });
    try {
      check(Number(this.db.prepare("PRAGMA user_version").get()!.user_version) === SCHEMA_VERSION && Number(this.db.prepare("PRAGMA application_id").get()!.application_id) === 1331110449, "UNKNOWN_DATABASE", "数据库尚未就绪，须由 Bootstrap 检测和迁移");
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      this.files = new FileStore(this.root);
    } catch(error) { this.db.close(); throw error; }
  }
  close() { this.scriptTestTransient.clear(); if(this.db.isOpen) this.db.close(); }
  recoverBusiness() {
    return configCoordinator(this).withWrite(() => { rmSync(this.files.path("staging"), { force: true, recursive: true }); this.recover();
    });
  }
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
  /**
   * 事务外文件准备（设计 §5.2）：小值生成 inline 描述，大值在受控 staging 写入、
   * fsync 后安装到不可变内容寻址路径并 fsync 父目录，返回不含可变外部路径的描述。
   * 复用已有文件时校验字节数与摘要。输入必须先经过敏感策略。
   */
  prepareReference(value: unknown): PreparedReference {
    const text = json(value);
    const byteSize = Buffer.byteLength(text);
    check(byteSize <= 16 * 1024 * 1024, "OUTPUT_LIMIT", "结果超过 16 MiB");
    if (byteSize <= 32768) return { kind: "inline", value: value ?? null };
    const hash = digest(text);
    const relativePath = `artifacts/blobs/${hash}.json`;
    const target = this.files.path(relativePath);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      check(existing.isFile() && !existing.isSymbolicLink() && existing.size === byteSize, "ARTIFACT_MISMATCH", "已安装产物文件大小不一致");
      check(digest(readFileSync(target)) === hash, "ARTIFACT_MISMATCH", "已安装产物摘要不一致");
    } else {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      mkdirSync(this.files.path("staging"), { recursive: true, mode: 0o700 });
      const stagingPath = this.files.path(`staging/${randomUUID()}.json`);
      const fd = openSync(stagingPath, "wx", 0o600);
      try {
        writeFileSync(fd, text, { mode: 0o600 });
        fsyncSync(fd);
      } finally { closeSync(fd); }
      try {
        renameSync(stagingPath, target);
      } catch (error) {
        // 并发准备同一内容时目标已安装；逐字节校验后复用。
        const installed = lstatSync(target, { throwIfNoEntry: false });
        check(installed?.isFile() && installed.size === byteSize && digest(readFileSync(target)) === hash, "ARTIFACT_MISMATCH", "产物安装失败");
      }
      const dirFd = openSync(dirname(target), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
    return { kind: "blob", artifactId: hash, relativePath, sha256: hash, byteSize };
  }
  /** 只在事务内校验描述并登记 artifacts 行、返回引用编码；不创建目录、写文件或编译。 */
  attachPreparedReference(prepared: unknown): string {
    check(prepared !== null && typeof prepared === "object" && !Array.isArray(prepared), "ARTIFACT_MISMATCH", "预准备描述无效");
    const record = prepared as Record<string, unknown>;
    if (record.kind === "inline") {
      check(Object.keys(record).length === 2, "ARTIFACT_MISMATCH", "inline 预准备描述字段无效");
      return json({ inline: record.value ?? null });
    }
    check(record.kind === "blob" && Object.keys(record).length === 5, "ARTIFACT_MISMATCH", "blob 预准备描述字段无效");
    check(typeof record.artifactId === "string" && /^[0-9a-f]{64}$/.test(record.artifactId) && record.artifactId === record.sha256, "ARTIFACT_MISMATCH", "blob 预准备描述摘要无效");
    check(typeof record.relativePath === "string" && record.relativePath === `artifacts/blobs/${record.artifactId}.json`, "ARTIFACT_MISMATCH", "blob 预准备描述路径无效");
    check(typeof record.byteSize === "number" && Number.isInteger(record.byteSize) && record.byteSize > 32768 && record.byteSize <= 16 * 1024 * 1024, "ARTIFACT_MISMATCH", "blob 预准备描述大小无效");
    const target = lstatSync(this.files.path(record.relativePath), { throwIfNoEntry: false });
    check(target?.isFile() && !target.isSymbolicLink() && target.size === record.byteSize, "ARTIFACT_MISSING", "预准备产物文件不存在或大小不一致");
    this.exec("INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?)", record.artifactId, record.relativePath, record.sha256, record.byteSize, "application/json", Date.now());
    return json({ artifactId: record.artifactId });
  }
  dereference(ref: unknown): unknown {
    if (!ref) return undefined;
    const value = parsed<{ inline?: unknown; artifactId?: string }>(ref);
    if (Object.hasOwn(value, "inline")) return value.inline;
    const artifact = this.one("SELECT * FROM artifacts WHERE id=?", value.artifactId!);
    check(artifact, "ARTIFACT_MISSING", "产物记录不存在");
    return this.files.readBlob(String(artifact.relative_path), String(artifact.sha256), Number(artifact.byte_size));
  }
  /** Private workflow inputs use keyed receipts and never enter the ordinary SHA-256 protocol. */
  workflowRunCommand<T>(scope: string, requestId: string, input: unknown, operation: () => T, privateInput = false): T {
    check(/^(run|draft-run):/.test(scope), "INVALID_SCOPE", "工作流运行 scope 无效");
    const protectedScope = `private-${scope}`;
    if (!privateInput && !this.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", protectedScope, requestId)) return this.command(scope, requestId, input, operation);
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    const hmac = new CommandHmac(this, this.root, new KeyringStore(resolveKeyringPath(this.root)));
    const hash = sensitiveRequestDigest(hmac.ensure(), protectedScope, input);
    return this.receiptedCommand(protectedScope, requestId, hash, operation);
  }
  command<T>(scope: string, requestId: string, input: unknown, operation: () => T): T {
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    const hash = digest(canonicalJson(input));
    return this.receiptedCommand(scope, requestId, hash, operation);
  }
  /**
   * 敏感命令入口（§7.4）：请求摘要由调用方以本机 HMAC 预先计算，
   * 不把明文交给旧 SHA-256 协议；scope 限定敏感命名空间，
   * 调用者不能指定任意摘要或 scope。回执仅保存 HMAC 与安全 DTO。
   */
  sensitiveCommand<T>(scope: string, requestId: string, requestHash: string, operation: () => T): T {
    check(/^(dictionary-secret|secrets):[a-z][a-z-]*$/.test(scope), "INVALID_SCOPE", "敏感命令 scope 无效");
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    check(typeof requestHash === "string" && /^[0-9a-f]{64}$/.test(requestHash), "INVALID_REQUEST_ID", "敏感请求摘要无效");
    return this.receiptedCommand(scope, requestId, requestHash, operation);
  }
  private receiptedCommand<T>(scope: string, requestId: string, hash: string, operation: () => T): T {
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
  saveProvider(setting: ProviderSetting) {
    return configCoordinator(this).withWrite(() => { this.exec("INSERT INTO provider_settings VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,config_json=excluded.config_json,models_json=excluded.models_json,default_model=excluded.default_model,revision=excluded.revision,updated_at=excluded.updated_at", setting.id, setting.enabled ? 1 : 0, json(setting.config), json(setting.models), setting.defaultModel, setting.revision, setting.updatedAt);
    });
  }
  script(id: string): ScriptView {
    const row = this.one("SELECT * FROM scripts WHERE id=?", id); check(row, "NOT_FOUND", "脚本不存在");
    return { id: String(row.id), name: String(row.name), description: String(row.description), runtime: row.runtime as ScriptView["runtime"], status: row.status as ScriptView["status"], currentDraftVersionId: row.current_draft_version_id as string | null, currentPublishedVersionId: row.current_published_version_id as string | null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), archivedAt: row.archived_at as number | null };
  }
  scripts() { return this.all<{ id: string }>("SELECT id FROM scripts ORDER BY updated_at DESC").map(row => this.script(row.id)); }
  scriptVersion(id: string): ScriptVersion {
    const row = this.one("SELECT * FROM script_versions WHERE id=?", id); check(row, "NOT_FOUND", "脚本版本不存在");
    return { id: String(row.id), scriptId: String(row.script_id), number: Number(row.version_no), status: row.status as "draft" | "published", revision: Number(row.revision), entryFile: String(row.entry_file), timeoutMs: Number(row.timeout_ms), inputSchema: parsed(row.input_schema_json), outputSchema: parsed(row.output_schema_json), sourceRef: String(row.source_ref), contentHash: String(row.content_hash), validation: parsed(row.validation_json), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), publishedAt: row.published_at as number | null };
  }
  scriptVersions(scriptId: string) { this.script(scriptId); return this.all<{ id: string }>("SELECT id FROM script_versions WHERE script_id=? ORDER BY version_no DESC", scriptId).map(row => this.scriptVersion(row.id)); }
  scriptDefinition(scriptId: string, versionId: string): ScriptDefinition {
    const script = this.script(scriptId), version = this.scriptVersion(versionId);
    check(version.scriptId === scriptId, "NOT_FOUND", "脚本版本不属于该脚本");
    const tree = this.files.readScriptTree(version.sourceRef);
    return validateScript({
      id: script.id, name: tree.definition?.name ?? script.name, description: tree.definition?.description ?? script.description,
      runtime: script.runtime, entryFile: version.entryFile, timeoutMs: version.timeoutMs,
      inputSchema: version.inputSchema, outputSchema: version.outputSchema, files: tree.files,
      resultMode: tree.definition?.resultMode ?? (script.runtime === "shell" ? "process" : "json"),
      ...(tree.definition?.dictionaryBindings ? { dictionaryBindings: tree.definition.dictionaryBindings } : {}),
    });
  }
  assertWorkflowScripts(definition: Workflow, allowArchived = false) {
    for (const node of definition.nodes) if (node.type === "script") {
      const script = this.script(node.config.scriptId!);
      check(script.currentPublishedVersionId && (script.status !== "archived" || allowArchived), "SCRIPT_NOT_PUBLISHED", "工作流只能引用已发布脚本");
      const version = this.scriptVersion(node.config.scriptVersionId!);
      check(version.scriptId === script.id && version.status === "published", "SCRIPT_VERSION_INVALID", "脚本版本无效或未发布");
    }
    workflowDictionarySensitivity(definition, (id, versionId) => this.scriptDefinition(id, versionId));
  }
  workflowScriptContracts(definition: Workflow) {
    this.assertWorkflowScripts(definition);
    const diagnostics: { nodeId: string; contract: string; status: "compatible" | "incompatible" | "unknown" }[] = [];
    for (const node of definition.nodes) if (node.type === "script") {
      const version = this.scriptVersion(node.config.scriptVersionId!);
      diagnostics.push({ nodeId: node.id, contract: "输入绑定", status: schemaSubset(bindingSchema(node.input, definition), version.inputSchema) });
      if (node.inputSchema !== undefined) diagnostics.push({ nodeId: node.id, contract: "节点输入 Schema", status: schemaSubset(node.inputSchema, version.inputSchema) });
      diagnostics.push({ nodeId: node.id, contract: "节点输出 Schema", status: schemaSubset(node.outputSchema, version.outputSchema) });
    }
    return diagnostics;
  }
  assertWorkflowScriptContracts(definition: Workflow) {
    const diagnostics = this.workflowScriptContracts(definition);
    const errors = diagnostics.filter(item => item.status === "incompatible");
    check(!errors.length, "SCRIPT_CONTRACT_MISMATCH", errors.map(item => `${item.nodeId} ${item.contract}与脚本契约不兼容`).join("；"));
    return diagnostics;
  }
  createScript(definition: ScriptDefinition, sourceRef: string, contentHash: string, validation: ScriptVersion["validation"] = { valid: true, diagnostics: [] }) {
    return configCoordinator(this).withWrite(() => {
      validateScript(definition); const now = Date.now(), scriptId = definition.id, versionId = randomUUID();
      return this.transaction(() => {
        check(!this.one("SELECT id FROM scripts WHERE id=?", scriptId), "IDENTITY_CONFLICT", "脚本 ID 已存在", 409);
        this.exec("INSERT INTO scripts(id,name,description,runtime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", scriptId, definition.name, definition.description, definition.runtime, "draft", now, now);
        this.exec("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", versionId, scriptId, 1, "draft", 0, definition.entryFile, definition.timeoutMs ?? 300000, json(definition.inputSchema), json(definition.outputSchema), sourceRef, contentHash, json(validation), now, now);
        this.exec("UPDATE scripts SET current_draft_version_id=? WHERE id=?", versionId, scriptId);
        return { script: this.script(scriptId), version: this.scriptVersion(versionId) };
      });
    });
  }
  updateScriptDraft(scriptId: string, expectedRevision: number, definition: ScriptDefinition, sourceRef: string, contentHash: string, validation: ScriptVersion["validation"] = { valid: true, diagnostics: [] }) {
    return configCoordinator(this).withWrite(() => {
      validateScript(definition); return this.transaction(() => {
        const script = this.script(scriptId); check(script.status === "draft" || script.status === "published", "SCRIPT_ARCHIVED", "脚本已归档");
        let current = script.currentDraftVersionId;
        const now = Date.now();
        if (!current) {
          check(expectedRevision === 0, "REVISION_CONFLICT", "请使用新的草稿修订号");
          current = randomUUID();
          const latest = this.one<{ n: number }>("SELECT COALESCE(MAX(version_no),0) AS n FROM script_versions WHERE script_id=?", scriptId)!.n;
          const published = script.currentPublishedVersionId ? this.scriptVersion(script.currentPublishedVersionId) : undefined;
          this.exec("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", current, scriptId, Number(latest) + 1, "draft", 0, published?.entryFile ?? definition.entryFile, definition.timeoutMs ?? published?.timeoutMs ?? 300000, json(published?.inputSchema ?? definition.inputSchema), json(published?.outputSchema ?? definition.outputSchema), published?.sourceRef ?? sourceRef, published?.contentHash ?? contentHash, json({ valid: true, diagnostics: [] }), now, now);
          this.exec("UPDATE scripts SET current_draft_version_id=?,updated_at=? WHERE id=?", current, now, scriptId);
        }
        const version = this.scriptVersion(current); check(version.revision === expectedRevision, "REVISION_CONFLICT", "脚本草稿已更新，请刷新后重试");
        check(definition.id === scriptId && definition.runtime === script.runtime, "IDENTITY_CONFLICT", "脚本身份或运行时不能修改");
        this.exec("UPDATE script_versions SET revision=revision+1,entry_file=?,timeout_ms=?,input_schema_json=?,output_schema_json=?,source_ref=?,content_hash=?,validation_json=?,updated_at=? WHERE id=? AND status='draft'", definition.entryFile, definition.timeoutMs ?? 300000, json(definition.inputSchema), json(definition.outputSchema), sourceRef, contentHash, json(validation), now, current);
        this.exec("UPDATE scripts SET name=?,description=?,updated_at=? WHERE id=?", definition.name, definition.description, now, scriptId);
        return { script: this.script(scriptId), version: this.scriptVersion(current) };
      });
    });
  }
  archiveScript(scriptId: string) {
    return configCoordinator(this).withWrite(() => {
      return this.transaction(() => { const script = this.script(scriptId); check(script.status !== "archived", "INVALID_STATE", "脚本已归档"); const now = Date.now(); this.exec("UPDATE scripts SET status='archived',archived_at=?,updated_at=? WHERE id=?", now, now, scriptId); return this.script(scriptId); });
    });
  }
  private readonly scriptTestTransient = new Map<string, unknown>();
  private readonly scriptTestActivities = new Map<string, () => void>();
  scriptTestInputPolicy(id: string): { version: 1; sources: HistorySources; transient: boolean } | undefined {
    const row = this.one<{ input_ref: string }>("SELECT input_ref FROM script_tests WHERE id=?", id);
    check(row, "NOT_FOUND", "脚本测试不存在");
    return JSON.parse(row.input_ref).scriptInput;
  }
  scriptTestHasTransient(id: string) { return this.scriptTestTransient.has(id); }
  clearScriptTestTransient(id: string) { this.scriptTestTransient.delete(id); }
  scriptTestRequirements(definition: ScriptDefinition, sources: ScriptInputSources, fixed?: ReturnType<DictionaryExecution["metadata"]>): DictionaryRequirement[] {
    const result = new Map(scriptDictionaryRequirements(definition.dictionaryBindings).map(r => [r.dictionaryId, r]));
    for (const ref of Object.values(sources)) {
      const kind = fixed ? fixed.find(b => b.dictionaryId === ref.dictionaryId)?.kind : this.one<{ kind: "plain" | "encrypted" }>("SELECT kind FROM dictionaries WHERE id=?", ref.dictionaryId)?.kind;
      check(kind, "DICTIONARY_NOT_FOUND", "字典不存在", 422);
      const prior = result.get(ref.dictionaryId);
      check(!prior || prior.kind === kind, "DICTIONARY_KIND_MISMATCH", "字典类型不符", 422);
      result.set(ref.dictionaryId, { dictionaryId: ref.dictionaryId, kind, keys: [...new Set([...(prior?.keys ?? []), ref.key])].sort() });
    }
    return [...result.values()].sort((a, b) => a.dictionaryId.localeCompare(b.dictionaryId));
  }
  trackScriptTestActivity(id: string) {
    if (!this.scriptTestActivities.has(id)) this.scriptTestActivities.set(id, configCoordinator(this).beginActivity(`script-test:${id}`));
  }
  createScriptTest(scriptId: string, versionId: string | null, draftRevision: number | null, input: unknown, requestId?: string, commandInput?: unknown, inputSources?: unknown) {
    return configCoordinator(this).withActivity("script-test:accept", () => {
      const scope = `script-test-v2:${scriptId}`, request = commandInput ?? { versionId, draftRevision, input, ...(inputSources === undefined ? {} : { inputSources }) };
      const hmac = new CommandHmac(this, this.root, new KeyringStore(resolveKeyringPath(this.root)));
      const requestHash = configCoordinator(this).withAdmission(() => sensitiveRequestDigest(hmac.ensure(), scope, request));
      const replay = () => this.receiptedCommand<{ id: string }>(scope, requestId!, requestHash, () => { throw new Error("unreachable"); });
      if (requestId && this.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", `script-test:${scriptId}`, requestId)) {
        const prior = this.command<{ id: string }>(`script-test:${scriptId}`, requestId, request, () => { throw new Error("unreachable"); });
        return this.scriptTest(prior.id);
      }
      if (requestId && this.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId)) {
        const prior = configCoordinator(this).withAdmission(replay);
        const test = this.scriptTest(prior.id);
        if (["queued", "running"].includes(test.status)) this.trackScriptTestActivity(test.id);
        return test;
      }
      const script = this.script(scriptId);
      check(script.status !== "archived", "SCRIPT_ARCHIVED", "脚本已归档");
      const selected = versionId ?? script.currentDraftVersionId;
      check(selected, "NOT_FOUND", "脚本版本不存在");
      const version = this.scriptVersion(selected);
      check(version.scriptId === scriptId && (versionId ? version.status === "published" : version.status === "draft" && version.revision === draftRevision), "REVISION_CONFLICT", "脚本版本或草稿修订已变化", 409);
      const snapshot = this.scriptDefinition(scriptId, selected);
      const sources = normalizeScriptInputSources(inputSources, snapshot.inputSchema);
      const captured = captureScriptInput(input, snapshot.inputSchema, sources);
      const preparedInput = this.prepareReference(captured.input), preparedSnapshot = this.prepareReference(snapshot);
      const dependencies = new DictionaryExecution(this);
      return configCoordinator(this).withAdmission(() => {
        const create = () => {
          const current = this.scriptVersion(selected), currentScript = this.script(scriptId);
          check(currentScript.status !== "archived", "SCRIPT_ARCHIVED", "脚本已归档");
          check(current.contentHash === version.contentHash && (versionId ? current.status === "published" : currentScript.currentDraftVersionId === selected && current.revision === draftRevision), "REVISION_CONFLICT", "脚本定义在准备期间变化", 409);
          const requirements = this.scriptTestRequirements(snapshot, sources);
          const admission = dependencies.validate(requirements);
          const inputRef = json({ ...JSON.parse(this.attachPreparedReference(preparedInput)), scriptSnapshot: this.attachPreparedReference(preparedSnapshot), scriptInput: { version: 1, sources: captured.sources, transient: captured.transient } });
          const id = randomUUID(), now = Date.now();
          this.exec("INSERT INTO script_tests(id,script_id,script_version_id,draft_revision,status,input_ref,created_at) VALUES(?,?,?,?,'queued',?,?)", id, scriptId, versionId, draftRevision, inputRef, now);
          dependencies.save("test", id, admission.bindings);
          dependencies.assertFingerprint(admission.fingerprint, requirements.some(r => r.kind === "encrypted"));
          return { id };
        };
        if (requestId !== undefined) check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "requestId 无效");
        const result = requestId ? this.receiptedCommand(scope, requestId, requestHash, create) : this.transaction(create);
        if (captured.transient) this.scriptTestTransient.set(result.id, stripReferencedInput(input, sources));
        const test = this.scriptTest(result.id);
        if (["queued", "running"].includes(test.status)) this.trackScriptTestActivity(test.id);
        return test;
      });
    });
  }
  scriptTestSnapshot(id: string): ScriptDefinition | undefined {
    const row = this.one("SELECT input_ref FROM script_tests WHERE id=?", id); check(row, "NOT_FOUND", "脚本测试不存在");
    const reference = parsed<{ scriptSnapshot?: string }>(row.input_ref);
    return reference.scriptSnapshot ? validateScript(this.dereference(reference.scriptSnapshot)) : undefined;
  }
  scriptTestInput(id: string): unknown {
    const row = this.one("SELECT input_ref FROM script_tests WHERE id=?", id); check(row, "NOT_FOUND", "脚本测试不存在");
    if (this.scriptTestInputPolicy(id)?.transient) {
      check(this.scriptTestTransient.has(id), "INTERRUPTED", "服务重启，敏感参数需要重新填写");
      return structuredClone(this.scriptTestTransient.get(id));
    }
    return this.dereference(row.input_ref);
  }
  scriptTestSensitive(id: string): boolean {
    if (this.scriptTestInputPolicy(id)?.transient) return true;
    if (this.one("SELECT 1 FROM script_test_dictionary_bindings b JOIN dictionary_versions v ON v.id=b.dictionary_version_id WHERE b.test_id=? AND v.kind='encrypted'", id)) return true;
    try { return Object.values(this.scriptTestSnapshot(id)?.dictionaryBindings ?? {}).some(binding => binding.kind === "encrypted"); }
    catch { return true; } // Broken immutable metadata must not downgrade the disclosure policy.
  }
  scriptTest(id: string) {
    const row = this.one("SELECT * FROM script_tests WHERE id=?", id); check(row, "NOT_FOUND", "脚本测试不存在");
    const sensitive = this.scriptTestSensitive(id);
    const policy = this.scriptTestInputPolicy(id);
    return { id: String(row.id), scriptId: String(row.script_id), scriptVersionId: row.script_version_id as string | null, draftRevision: row.draft_revision as number | null, status: String(row.status),
      reusableInput: policy ? this.dereference(row.input_ref) : sensitive ? null : this.dereference(row.input_ref), inputSources: policy?.sources ?? {}, legacyInput: !policy,
      input: sensitive ? REDACTED : this.dereference(row.input_ref), output: row.output_ref ? sensitive ? REDACTED : this.dereference(row.output_ref) : undefined,
      error: row.error_json ? parsed(row.error_json) : undefined, stdout: row.stdout_ref ? sensitive ? REDACTED : this.dereference(row.stdout_ref) : undefined, stderr: row.stderr_ref ? sensitive ? REDACTED : this.dereference(row.stderr_ref) : undefined,
      inputRedacted: sensitive, outputRedacted: sensitive, logsRedacted: sensitive, dictionaryBindings: new DictionaryExecution(this).metadata("test", id),
      exitCode: row.exit_code as number | null, durationMs: row.duration_ms as number | null, createdAt: Number(row.created_at), startedAt: row.started_at as number | null, endedAt: row.ended_at as number | null };
  }
  scriptTests(scriptId: string) { this.script(scriptId); return this.all<{ id: string }>("SELECT id FROM script_tests WHERE script_id=? ORDER BY created_at DESC", scriptId).map(row => this.scriptTest(row.id)); }
  setScriptTestRunning(id: string) { this.trackScriptTestActivity(id); this.exec("UPDATE script_tests SET status='running',started_at=? WHERE id=? AND status='queued'", Date.now(), id); }
  finishScriptTest(id: string, result: { status: "succeeded" | "failed" | "cancelled"; output?: unknown; error?: unknown; stdout: string; stderr: string; exitCode?: number | null; durationMs?: number }) {
    const sensitive = this.scriptTestSensitive(id);
    const output = result.output === undefined ? undefined : sensitive ? REDACTED : result.output;
    const stdout = sensitive ? REDACTED : result.stdout, stderr = sensitive ? REDACTED : result.stderr;
    const detail = result.error === undefined ? undefined : sensitive ? safeExecutionFailure(result.error instanceof AppError ? result.error : new AppError(String((result.error as { code?: string }).code ?? "EXECUTION_FAILED"), ""), true) : result.error;
    this.transaction(() => { const now = Date.now(); this.exec("UPDATE script_tests SET status=?,output_ref=?,error_json=?,stdout_ref=?,stderr_ref=?,exit_code=?,duration_ms=?,ended_at=? WHERE id=? AND status='running'", result.status, output === undefined ? null : this.reference(output), detail === undefined ? null : json(detail), this.reference(stdout), this.reference(stderr), result.exitCode ?? null, result.durationMs ?? null, now, id); });
    const test = this.scriptTest(id);
    if (!["queued", "running"].includes(test.status)) { this.scriptTestTransient.delete(id); this.scriptTestActivities.get(id)?.(); this.scriptTestActivities.delete(id); }
    return test;
  }
  publishScript(scriptId: string, expectedRevision: number) {
    return configCoordinator(this).withWrite(() => {
      return this.transaction(() => {
        const script = this.script(scriptId), draftId = script.currentDraftVersionId; check(draftId, "NOT_FOUND", "脚本没有草稿");
        check(script.status !== "archived", "SCRIPT_ARCHIVED", "脚本已归档");
        const draft = this.scriptVersion(draftId); check(draft.revision === expectedRevision, "REVISION_CONFLICT", "脚本草稿已更新，请刷新后重试");
        const now = Date.now(); this.exec("UPDATE script_versions SET status='published',published_at=?,updated_at=? WHERE id=?", now, now, draftId);
        this.exec("UPDATE scripts SET status='published',current_published_version_id=?,current_draft_version_id=NULL,updated_at=? WHERE id=?", draftId, now, scriptId);
        return { script: this.script(scriptId), version: this.scriptVersion(draftId) };
      });
    });
  }
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
    return configCoordinator(this).withWrite(() => {
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
    });
  }
  deleteDraft(id: string) {
    return configCoordinator(this).withWrite(() => {
      return this.transaction(() => {
        if (!this.one("SELECT id FROM drafts WHERE id=?", id)) return { id, deleted: true };
        check(this.draft(id).status !== "published", "DRAFT_BUSY", "已发布草稿请通过工作流详情删除");
        this.deleteContent([id], []);
        return { id, deleted: true };
      });
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
      modelId: String(r.model_id), transport: String(r.transport) as "native", connectionFingerprint: String(r.connection_fingerprint),
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
    const status = target.mode === "multi" && target.connectionFingerprint === "" ? "needs_rebuild" : "current";
    if (status === "current") this.demoteCurrentConversation(draftId);
    const changed = Number(this.exec("UPDATE agent_conversations SET status=?,updated_at=? WHERE id=? AND draft_id=? AND status='archived'", status, Date.now(), id, draftId).changes);
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
    const output = this.dereference(r.output_ref), dictionaryBindings = new DictionaryExecution(this).metadata("run", id);
    const input = this.dereference(r.input_ref), privateInput = isRedacted(input);
    return { ...(privateInput ? { inputRedacted: true, logsRedacted: true } : {}), ...(isRedacted(output) ? { outputRedacted: true } : {}), ...(dictionaryBindings.length ? { dictionaryBindings, logsRedacted: privateInput || dictionaryBindings.some(b => b.kind === "encrypted") } : {}), id: String(r.id), workflowVersionId: r.workflow_version_id as string | null, draftId: r.draft_id as string | null, draftRevision: r.draft_revision as number | null, snapshotPath: r.snapshot_path as string | null, status: r.status as Run["status"], input, output, activeNodeId: r.active_node_id as string | null, error: parsed(r.error_json), createdAt: Number(r.created_at), startedAt: r.started_at as number | null, endedAt: r.ended_at as number | null };
  }
  runs() { return this.all<{ id: string }>("SELECT id FROM runs ORDER BY created_at DESC LIMIT 200").map(r => this.run(r.id)); }
  runSummaries(filters: { workflowId?: string; draftId?: string; type?: string; status?: string } = {}) {
    const snapshotNames = new Map<string, string>();
    return this.all<RunSummary & { snapshotPath: string | null }>(`
      SELECT r.id,COALESCE(v.workflow_id,d.workflow_id,pv.workflow_id) AS workflowId,
        COALESCE(json_extract(v.definition_json,'$.name'),w.name,'未命名草稿') AS workflowName,
        r.workflow_version_id AS workflowVersionId,v.version_no AS versionNumber,
        r.draft_id AS draftId,r.draft_revision AS draftRevision,r.snapshot_path AS snapshotPath,r.status,
        r.created_at AS createdAt,r.started_at AS startedAt,r.ended_at AS endedAt
      FROM runs r
      LEFT JOIN workflow_versions v ON v.id=r.workflow_version_id
      LEFT JOIN drafts d ON d.id=r.draft_id
      LEFT JOIN workflow_versions pv ON pv.id=d.published_version_id
      LEFT JOIN workflows w ON w.id=COALESCE(v.workflow_id,d.workflow_id,pv.workflow_id)
      WHERE (? IS NULL OR COALESCE(v.workflow_id,d.workflow_id,pv.workflow_id)=?)
        AND (? IS NULL OR r.draft_id=?)
        AND (? IS NULL OR r.status=?)
        AND (? IS NULL OR (?='test' AND r.draft_id IS NOT NULL) OR (?='formal' AND r.workflow_version_id IS NOT NULL))
      ORDER BY r.created_at DESC,r.rowid DESC LIMIT 200`,
      filters.workflowId ?? null, filters.workflowId ?? null, filters.draftId ?? null, filters.draftId ?? null,
      filters.status ?? null, filters.status ?? null, filters.type ?? null, filters.type ?? null, filters.type ?? null
    ).map(run => {
      let workflowName = run.workflowName;
      if (run.snapshotPath) {
        try {
          if (!snapshotNames.has(run.snapshotPath)) snapshotNames.set(run.snapshotPath, JSON.parse(this.files.readTree(run.snapshotPath).files["workflow.json"]!).name);
          workflowName = snapshotNames.get(run.snapshotPath) ?? workflowName;
        } catch {}
      }
      return { ...this.run(run.id), ...run, workflowName };
    });
  }
  latestWorkflowRun(workflowId: string) {
    return this.one<{ id: string; status: Run["status"]; createdAt: number }>(`
      SELECT r.id,r.status,r.created_at AS createdAt FROM runs r
      JOIN workflow_versions v ON v.id=r.workflow_version_id
      WHERE v.workflow_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`, workflowId) ?? null;
  }
  nodes(runId: string): NodeRun[] {
    return this.all("SELECT * FROM node_runs WHERE run_id=? ORDER BY rowid", runId).map(r => ({
      id: String(r.id), runId, nodeId: String(r.node_id), type: r.type as NodeRun["type"], status: r.status as NodeRun["status"],
      input: this.dereference(r.input_ref), output: this.dereference(r.output_ref), route: parsed(r.route_json),
      ...(isRedacted(this.dereference(r.input_ref)) ? { inputRedacted: true, logsRedacted: true } : {}), ...(isRedacted(this.dereference(r.output_ref)) ? { outputRedacted: true, logsRedacted: true } : {}),
      skipReason: r.skip_reason as string | undefined, error: parsed(r.error_json), startedAt: r.started_at as number | null, endedAt: r.ended_at as number | null,
    }));
  }
  attempts(runId: string) { return this.all("SELECT a.* FROM node_attempts a JOIN node_runs n ON n.id=a.node_run_id WHERE n.run_id=? ORDER BY a.started_at", runId).map(r => ({ id: r.id, nodeRunId: r.node_run_id, status: r.status, execution: parsed(r.execution_json), ...(isRedacted(this.dereference(r.input_ref)) ? { inputRedacted: true, logsRedacted: true } : {}), ...(isRedacted(this.dereference(r.output_ref)) ? { outputRedacted: true } : {}), input: this.dereference(r.input_ref), output: this.dereference(r.output_ref), error: parsed(r.error_json), startedAt: r.started_at, endedAt: r.ended_at })); }
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
