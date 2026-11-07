import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { configCoordinator, registerConfigCoordinator, type ConfigWriteCoordinator } from "./coordinator.js";
import type { PortableSnapshot, SnapshotCategory, SnapshotTheme } from "./snapshot-types.js";
import { durableJson, durableWrite, readJson, readOptional, syncFile } from "./restore-files.js";
import { captureSnapshot, prepareImport, importDefinitions, targetFingerprint, databaseFingerprint, assertIdle, type PreparedImport } from "./restore-import.js";
export type { PortableSnapshot } from "./snapshot-types.js";

export interface RestorePreviewOptions {
  categories?: SnapshotCategory[];
  mappings?: Record<string, string>;
  source?: { kind: "git"; sha: string } | { kind: "recovery-point"; id: string };
  context?: unknown;
  clientId?: string;
  preferenceRevision?: number;
}
export interface RestorePreview {
  token: string; planHash: string; targetHash: string; generation: number; expiresAt: number;
  categories: SnapshotCategory[]; source?: RestorePreviewOptions["source"]; context?: unknown;
  changes: { category: SnapshotCategory; objectId: string; changeType: "add" | "update" | "same"; detail?: string }[];
}
export type RestorePhase = "accepted" | "prepared" | "db_committed" | "files_installed" | "completed" | "failed" | "recovery_required";
export interface RestoreOperation {
  operationId: string; requestId: string; planHash: string; recoveryPointId: string; phase: RestorePhase;
  previewToken: string; createdAt: number; source?: RestorePreviewOptions["source"];
  files: { target: string; staged: string; hash: string }[]; installed: string[];
  result?: { operationId: string; planHash: string; recoveryPointId: string; changed: number; phase: "completed" };
  error?: string;
}
interface GeneralState { theme: SnapshotTheme; pending: { clientId: string | null; operationId: string; revision: number | null; theme: SnapshotTheme; requiresConfirmation?: boolean; acknowledged?: "applied" | "kept" }[] }
interface InternalPreview { public: RestorePreview; snapshot: PortableSnapshot; options: RestorePreviewOptions; prepared: PreparedImport }
export interface RestoreServiceOptions {
  afterRestore?: () => void | Promise<void>;
  /** Fault hook runs after each durable boundary; tests can terminate a real process here. */
  fault?: (phase: string, operation: RestoreOperation) => void;
}
const SCOPE = "config-git:restore";
export class ConfigRestoreService {
  private previews = new Map<string, InternalPreview>();
  readonly coordinator: ConfigWriteCoordinator;
  constructor(readonly store: Store, coordinator = configCoordinator(store), readonly options: RestoreServiceOptions = {}) { this.coordinator = coordinator; registerConfigCoordinator(store, coordinator); }
  getGeneralTheme(): SnapshotTheme | undefined { const raw = readOptional(this.store, "config-git/general.json"); return raw ? (JSON.parse(raw) as GeneralState).theme : undefined; }
  saveGeneralSnapshot(theme: SnapshotTheme) {
    check(["light", "dark", "system"].includes(theme), "INVALID_THEME", "外观值无效");
    this.coordinator.withWrite(() => { const state = this.general(); state.theme = theme; durableJson(this.store, "config-git/general.json", state); });
  }
  private general(): GeneralState { const raw = readOptional(this.store, "config-git/general.json"); return raw ? { pending: [], ...JSON.parse(raw) } : { theme: "system", pending: [] }; }
  async preview(snapshot: PortableSnapshot, options: RestorePreviewOptions = {}): Promise<RestorePreview> {
    return this.coordinator.withRead(async () => {
      if (options.clientId !== undefined) check(typeof options.clientId === "string" && options.clientId.length > 0 && options.clientId.length <= 200 && Number.isSafeInteger(options.preferenceRevision) && options.preferenceRevision! >= 0, "INVALID_PREFERENCE", "浏览器偏好身份或修订无效");
      const copy = structuredClone(snapshot), settings = structuredClone(options);
      const prepared = await prepareImport(this.store, copy, settings);
      const targetHash = targetFingerprint(this.store), generation = this.coordinator.generation;
      const planHash = digest(canonicalJson({ snapshot: copy, options: settings, categories: prepared.categories, targetHash }));
      const result: RestorePreview = { token: randomUUID(), planHash, targetHash, generation, expiresAt: Date.now() + 30 * 60_000, categories: prepared.categories, changes: prepared.changes, ...(settings.source ? { source: settings.source } : {}), ...(settings.context === undefined ? {} : { context: settings.context }) };
      this.previews.set(result.token, { public: result, snapshot: copy, options: settings, prepared });
      return structuredClone(result);
    });
  }
  async apply(requestId: string, previewToken: string, context?: unknown): Promise<RestoreOperation> {
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    const prior = this.operations().find(item => item.requestId === requestId);
    if (prior) {
      check(prior.previewToken === previewToken, "REQUEST_CONFLICT", "同一请求标识已用于其他恢复计划", 409);
      return prior.phase === "completed" || prior.phase === "failed" ? prior : this.recover(prior.operationId).then(() => this.operation(prior.operationId));
    }
    const preview = this.previews.get(previewToken);
    check(preview && preview.public.expiresAt > Date.now(), "PREVIEW_EXPIRED", "恢复预览已过期", 409);
    check(canonicalJson(context ?? null) === canonicalJson(preview.options.context ?? null), "PREVIEW_EXPIRED", "仓库上下文已变化", 409);
    return this.coordinator.withExclusive(async () => {
      assertIdle(this.store);
      check(preview.public.generation === this.coordinator.generation && preview.public.targetHash === targetFingerprint(this.store), "PREVIEW_EXPIRED", "目标配置已变化", 409);
      const operation: RestoreOperation = { operationId: randomUUID(), requestId, planHash: preview.public.planHash, recoveryPointId: randomUUID(), previewToken, phase: "accepted", createdAt: Date.now(), ...(preview.options.source ? { source: preview.options.source } : {}), files: [], installed: [] };
      this.save(operation); this.options.fault?.("accepted", operation);
      try {
        const recovery = captureSnapshot(this.store, this.general().theme);
        durableJson(this.store, `config-git/recovery-points/${operation.recoveryPointId}.json`, { id: operation.recoveryPointId, createdAt: Date.now(), snapshot: recovery.snapshot, mappings: recovery.mappings, categories: preview.public.categories });
        const files = { ...preview.prepared.files };
        if (preview.public.categories.includes("general")) {
          const state = this.general(); state.theme = preview.snapshot.general.theme;
          state.pending.push({ clientId: preview.options.clientId ?? null, operationId: operation.operationId, revision: preview.options.preferenceRevision ?? null, theme: state.theme });
          files["config-git/general.json"] = JSON.stringify(state);
        }
        for (const [target, content] of Object.entries(files)) {
          const staged = `config-git/staging/${operation.operationId}/${operation.files.length}.json`;
          durableWrite(this.store, staged, content); operation.files.push({ target, staged, hash: digest(content) });
        }
        durableJson(this.store, `config-git/staging/${operation.operationId}/plan.json`, { snapshot: preview.snapshot, options: preview.options, planHash: operation.planHash });
        operation.phase = "prepared"; this.save(operation); this.options.fault?.("prepared", operation);
        this.store.command(SCOPE, requestId, { planHash: operation.planHash }, () => {
          importDefinitions(this.store, preview.prepared);
          this.options.fault?.("transaction", operation);
          return { operationId: operation.operationId, planHash: operation.planHash, recoveryPointId: operation.recoveryPointId, databaseHash: databaseFingerprint(this.store), changed: preview.public.changes.filter(item => item.changeType !== "same").length };
        });
        this.options.fault?.("database_committed_before_journal", operation);
        operation.phase = "db_committed"; this.save(operation);
        await this.finish(operation);
        return operation;
      } catch (error) {
        operation.phase = this.receipt(operation) ? "recovery_required" : "failed";
        operation.error = error instanceof Error ? error.message : "恢复失败";
        if (operation.phase === "recovery_required") this.coordinator.setMaintenance("配置恢复需要修复");
        this.save(operation); throw error;
      }
    });
  }
  private receipt(operation: RestoreOperation) {
    const row = this.store.one<{ request_hash: string; result_json: string }>("SELECT request_hash,result_json FROM command_receipts WHERE scope=? AND request_id=?", SCOPE, operation.requestId);
    if (!row) return undefined;
    check(row.request_hash === digest(canonicalJson({ planHash: operation.planHash })), "RECOVERY_REQUIRED", "恢复回执摘要不匹配", 503);
    const result = JSON.parse(row.result_json) as { operationId: string; planHash: string; recoveryPointId: string; changed: number; databaseHash: string };
    check(result.operationId === operation.operationId && result.planHash === operation.planHash && result.recoveryPointId === operation.recoveryPointId, "RECOVERY_REQUIRED", "恢复回执身份不匹配", 503);
    return result;
  }
  private async finish(operation: RestoreOperation) {
    const receipt = this.receipt(operation); check(receipt, "RECOVERY_REQUIRED", "恢复回执缺失", 503);
    check(databaseFingerprint(this.store) === receipt.databaseHash, "RECOVERY_REQUIRED", "恢复数据库或源码最终摘要不匹配", 503);
    for (const file of operation.files) {
      check(["config/web-bridge.json", "config-git/general.json", "config-git/local-mappings.json"].includes(file.target), "RECOVERY_REQUIRED", "恢复文件目标无效", 503);
      const content = readOptional(this.store, file.staged);
      check(content !== null && digest(content) === file.hash, "RECOVERY_REQUIRED", "恢复暂存文件缺失或损坏", 503);
      this.options.fault?.(`before_file:${file.target}`, operation);
      if (digest(readOptional(this.store, file.target) ?? "") !== file.hash) durableWrite(this.store, file.target, content);
      this.options.fault?.(`after_file:${file.target}`, operation);
      if (!operation.installed.includes(file.target)) operation.installed.push(file.target);
      this.save(operation);
    }
    operation.phase = "files_installed"; this.save(operation); this.options.fault?.("files_installed", operation);
    await this.options.afterRestore?.();
    for (const file of operation.files) check(digest(readOptional(this.store, file.target) ?? "") === file.hash, "RECOVERY_REQUIRED", "恢复文件最终校验失败", 503);
    this.options.fault?.("before_completed", operation);
    operation.phase = "completed"; delete operation.error;
    operation.result = { ...receipt, phase: "completed" }; this.save(operation);
  }
  /** Must run before Store.recoverBusiness(), service cache construction and queue startup. */
  async recover(operationId?: string): Promise<RestoreOperation[]> {
    return this.coordinator.withExclusive(async () => {
      this.coordinator.setMaintenance("正在恢复配置一致性");
      try {
        const operations = this.operations();
        if (operationId) check(operations.some(item => item.operationId === operationId), "NOT_FOUND", "恢复操作不存在", 404);
        for (const operation of operations) {
          if (operation.phase === "completed" || operation.phase === "failed" || operationId && operation.operationId !== operationId) continue;
          try {
            if (this.receipt(operation)) await this.finish(operation);
            else { operation.phase = "failed"; operation.error = "数据库未提交，保留恢复前配置"; this.save(operation); }
          } catch (error) {
            operation.phase = "recovery_required"; operation.error = error instanceof Error ? error.message : "恢复失败"; this.save(operation); throw error;
          }
        }
        if (!this.operations().some(item => !["completed", "failed"].includes(item.phase))) this.coordinator.setMaintenance(null);
        return this.operations();
      } catch (error) { this.coordinator.setMaintenance("配置恢复需要修复"); throw error; }
    }, true);
  }
  private save(operation: RestoreOperation) { durableJson(this.store, `config-git/operations/${operation.operationId}.json`, operation); }
  operations(): RestoreOperation[] {
    const path = this.store.files.path("config-git/operations");
    return existsSync(path) ? readdirSync(path).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => readJson<RestoreOperation>(this.store, `config-git/operations/${name}`)).sort((a, b) => a.createdAt - b.createdAt) : [];
  }
  operation(id: string): RestoreOperation { const item = this.operations().find(item => item.operationId === id); check(item, "NOT_FOUND", "恢复操作不存在", 404); return item; }
  recoveryPoints() {
    const path = this.store.files.path("config-git/recovery-points");
    return existsSync(path) ? readdirSync(path).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => { const value = readJson<{ id: string; createdAt: number; categories: SnapshotCategory[] }>(this.store, `config-git/recovery-points/${name}`); return { id: value.id, createdAt: value.createdAt, categories: value.categories }; }) : [];
  }
  previewRecoveryPoint(id: string, options: RestorePreviewOptions = {}) {
    check(this.recoveryPoints().some(item => item.id === id), "NOT_FOUND", "恢复点不存在", 404);
    const value = readJson<{ snapshot: PortableSnapshot; mappings: Record<string, string>; categories: SnapshotCategory[] }>(this.store, `config-git/recovery-points/${id}.json`);
    return this.preview(value.snapshot, { ...options, categories: options.categories ?? value.categories, mappings: { ...value.mappings, ...options.mappings }, source: { kind: "recovery-point", id } });
  }
  deleteRecoveryPoint(id: string) {
    return this.coordinator.withWrite(() => {
      check(this.recoveryPoints().some(item => item.id === id), "NOT_FOUND", "恢复点不存在", 404);
      check(!this.operations().some(item => item.recoveryPointId === id && !["completed", "failed"].includes(item.phase)), "CONFIG_BUSY", "未完成恢复正在引用恢复点", 409);
      rmSync(this.store.files.path(`config-git/recovery-points/${id}.json`)); syncFile(this.store.files.path("config-git/recovery-points"));
    });
  }
  pendingGeneral(clientId: string) { this.coordinator.assertAvailable(); return this.general().pending.filter(item => item.clientId === clientId && !item.acknowledged); }
  claimGeneralSnapshot(clientId: string, revision: number) {
    return this.coordinator.withWrite(() => {
      check(typeof clientId === "string" && clientId.length > 0 && Number.isSafeInteger(revision) && revision >= 0, "INVALID_PREFERENCE", "浏览器偏好身份无效");
      check(this.getGeneralTheme(), "GENERAL_SNAPSHOT_MISSING", "尚无服务端常规快照", 422);
      const state = this.general(), item = { clientId, operationId: randomUUID(), revision, theme: state.theme, requiresConfirmation: true };
      state.pending.push(item); durableJson(this.store, "config-git/general.json", state); return item;
    });
  }
  claimGeneral(clientId: string, operationId: string, revision: number) {
    return this.coordinator.withWrite(() => { const state = this.general(), item = state.pending.find(item => item.operationId === operationId); check(item && (!item.clientId || item.clientId === clientId), "NOT_FOUND", "可领取的偏好不存在", 404); if (!item.clientId) { item.clientId = clientId; item.revision = revision; durableJson(this.store, "config-git/general.json", state); } return item; });
  }
  acknowledgeGeneral(clientId: string, operationId: string, revision: number, choice: "applied" | "kept", force = false) {
    return this.coordinator.withWrite(() => { const state = this.general(), item = state.pending.find(item => item.operationId === operationId && item.clientId === clientId); check(item, "NOT_FOUND", "待恢复偏好不存在", 404); if (item.acknowledged) return item; check(choice === "applied" || choice === "kept", "INVALID_CHOICE", "偏好回执无效"); check(choice === "kept" || force || !item.requiresConfirmation && item.revision === revision, "PREFERENCE_CONFLICT", "浏览器偏好已变化，请明确选择", 409); item.acknowledged = choice; durableJson(this.store, "config-git/general.json", state); return item; });
  }
}
