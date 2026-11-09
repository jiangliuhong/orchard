import { randomUUID } from "node:crypto";
import type { Store } from "../persistence/store.js";
import type { WebBridgeConfig } from "../web-bridge/config.js";
import { AppError, check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { configCoordinator } from "./coordinator.js";
import { ConfigOperations } from "./operations.js";
import { GitRepositoryService, GitRepositoryError, type GitRepositoryOptions, type GitFileDiff } from "./repository.js";
import { ConfigRestoreService, type RestorePreviewOptions } from "./restore.js";
import { captureSnapshot } from "./restore-import.js";
import { readOptional, readJson, durableJson } from "./restore-files.js";
import { exportSnapshot, parseSnapshot, portableScriptHash, portableWorkflowHash, type PortableSnapshot, type SnapshotTheme, type SnapshotCategory } from "./snapshot.js";
import { workflowDependencies } from "./snapshot-validation.js";

interface Preference { theme?: SnapshotTheme; clientId?: string; preferenceRevision?: number }
interface PreviewDiff { category: SnapshotCategory; objectId?: string; versionId?: string; path: string; changeType: string; before?: string | null; after?: string | null; sensitive?: boolean; detail?: string; blockingReason?: string; scope?: "current" | "cumulative" }
interface Blocker { code: string; category?: SnapshotCategory; objectId?: string; versionId?: string; message: string; incomingDigest?: string; targetDigest?: string }
interface PreviewView { token: string; expiresAt: number; categories: SnapshotCategory[]; diffs: PreviewDiff[]; cumulativeDiffs?: PreviewDiff[]; blockers: string[]; blockerDetails: Blocker[]; requiredMappings: { key: string; label: string }[]; nextCursor?: string; sourceSha?: string; warnings?: string[]; noChanges?: boolean }
interface SavedPreview { view: PreviewView; diffs: PreviewDiff[]; cumulative: PreviewDiff[]; kind: "commit" | "restore" | "blocked"; preference?: Preference; revision?: string }
const categories: SnapshotCategory[] = ["general", "providers", "webBridge", "scripts", "workflows"];
function category(path: string): SnapshotCategory { return path.startsWith("workflows/") ? "workflows" : path.startsWith("scripts/") ? "scripts" : path.includes("providers/") ? "providers" : path.includes("web-bridge") ? "webBridge" : "general"; }
// Never include known local mappings or authentication-shaped source in API diff text.
function safeDiff(diff: GitFileDiff, secrets: string[] = []): PreviewDiff {
  const text = `${diff.before ?? ""}\n${diff.after ?? ""}`;
  const sensitive = /(?:api[_-]?key|password|passwd|secret|authorization|bearer\s|private[_-]?key|access[_-]?token|refresh[_-]?token|["']?token["']?\s*[:=]|https?:\/\/[^\s/]+:[^\s/]+@)/i.test(text) || secrets.some(value => value.length > 0 && text.includes(value));
  return { category: category(diff.path), path: diff.path, changeType: diff.before === null ? "add" : diff.after === null ? "remove" : diff.before === diff.after ? "same" : "update", sensitive, before: sensitive ? "[已隐藏敏感内容]" : diff.before, after: sensitive ? "[已隐藏敏感内容]" : diff.after };
}
function preference(input: Preference): Preference {
  check(input.theme === undefined || ["light", "dark", "system"].includes(input.theme), "INVALID_PREFERENCE", "外观值无效", 422);
  check((input.clientId === undefined) === (input.preferenceRevision === undefined), "INVALID_PREFERENCE", "浏览器身份与偏好修订必须同时提供", 422);
  if (input.clientId !== undefined) check(typeof input.clientId === "string" && input.clientId.length > 0 && input.clientId.length <= 200 && Number.isSafeInteger(input.preferenceRevision) && input.preferenceRevision! >= 0, "INVALID_PREFERENCE", "浏览器偏好身份无效", 422);
  return { ...(input.theme !== undefined ? { theme: input.theme } : {}), ...(input.clientId !== undefined ? { clientId: input.clientId, preferenceRevision: input.preferenceRevision } : {}) };
}
export class ConfigGitService {
  readonly coordinator;
  readonly repository: GitRepositoryService;
  readonly operations: ConfigOperations;
  private locked = false;
  private previews = new Map<string, SavedPreview>();
  constructor(readonly store: Store, readonly bridge: WebBridgeConfig, readonly restore: ConfigRestoreService, options: GitRepositoryOptions = {}) {
    this.coordinator = configCoordinator(store);
    this.repository = new GitRepositoryService(store.files.root, { ...options, validateSnapshot: parseSnapshot });
    this.operations = new ConfigOperations(store.files.root);
  }
  async close() { await this.operations.close(); }
  private async lock<T>(action: () => Promise<T> | T) {
    check(!this.locked, "CONFIG_BUSY", "Git 配置操作正在进行", 409); this.locked = true;
    try { return await action(); } catch (error) {
      if (error instanceof GitRepositoryError) throw new AppError(error.code, error.message, error.code === "NOT_BOUND" ? 404 : 409);
      if (error instanceof AppError) throw new AppError(error.code, `配置操作失败 (${error.code})`, error.statusCode);
      throw error;
    } finally { this.locked = false; }
  }
  run(kind: string, input: Record<string, unknown>, action: () => Promise<unknown> | unknown) {
    return this.operations.start(kind, typeof input.requestId === "string" ? input.requestId : randomUUID(), input, () => this.lock(action));
  }
  private theme(theme?: SnapshotTheme) {
    const value = theme ?? this.restore.getGeneralTheme();
    check(value && ["light", "dark", "system"].includes(value), "GENERAL_SNAPSHOT_REQUIRED", "请在浏览器中保存常规偏好，或显式提供 theme", 422); return value;
  }
  export(theme?: SnapshotTheme) {
    const bundle = this.coordinator.withRead(() => exportSnapshot(this.store, this.bridge, this.theme(theme)));
    if (theme !== undefined && this.restore.getGeneralTheme() !== theme) this.restore.saveGeneralSnapshot(theme);
    return bundle;
  }
  private revision(theme: SnapshotTheme) { return digest(canonicalJson({ digest: exportSnapshot(this.store, this.bridge, theme).digest, generation: this.coordinator.generation })); }
  private savedMappings(): Record<string, string> {
    const value: unknown = JSON.parse(readOptional(this.store, "config-git/local-mappings.json") ?? "{}");
    check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(v => typeof v === "string"), "LOCAL_MAPPING_INVALID", "本机映射文件格式无效", 422);
    return value as Record<string, string>;
  }
  private localSecrets(): string[] {
    const values = Object.values(this.savedMappings());
    for (const row of this.store.all<{ id: string }>("SELECT id FROM provider_settings")) { const config = this.store.provider(row.id)!.config; for (const value of Object.values(config)) if (typeof value === "string" && value !== "legacy" && value !== "native") values.push(value); }
    const bridge = JSON.parse(readOptional(this.store, "config/web-bridge.json") ?? '{}');
    for (const envs of Object.values(bridge.environments ?? {}) as Record<string, unknown>[][]) for (const env of envs) for (const field of ["profileId", "extensionId"]) if (typeof env[field] === "string") values.push(env[field] as string);
    return values;
  }
  async status() {
    if (!await this.repository.getBinding()) return { binding: null, ahead: 0, behind: 0, diverged: false, dirtyPaths: [], maintenance: this.coordinator.maintenance };
    const value = await this.repository.status();
    return { ...value, localSha: value.head, dirtyPaths: value.dirty ? [value.dirtyReason ?? "工作区已修改"] : [], maintenance: this.coordinator.maintenance };
  }
  async commitPreview(input: Preference & { message: string; push?: boolean; regenerate?: boolean }) {
    const prefs = preference(input), theme = this.theme(input.theme);
    const { bundle, revision, secrets } = this.coordinator.withRead(() => ({
      bundle: exportSnapshot(this.store, this.bridge, theme), revision: this.revision(theme), secrets: this.localSecrets(),
    }));
    const preview = await this.repository.previewCommit({ message: input.message, push: input.push, regenerate: input.regenerate, files: bundle.files, revision });
    const diffs = preview.diff.map(d => safeDiff(d, secrets)), cumulative = preview.cumulativeDiff.map(d => safeDiff(d, secrets));
    const view: PreviewView = { token: preview.token, expiresAt: preview.expiresAt, categories, diffs: [], blockers: [], blockerDetails: [], requiredMappings: [], warnings: preview.regenerate ? ["确认后将备份本地历史，并基于最新远端重生成完整快照。"] : [], noChanges: diffs.length === 0 && (!preview.push || cumulative.length === 0) };
    this.previews.set(view.token, { view, diffs, cumulative, kind: "commit", preference: { ...prefs, theme }, revision });
    return this.previewPage(view.token);
  }
  messageAgent() {
    return this.coordinator.withRead(() => {
      const saved = readOptional(this.store, "config-git/message-agent.json");
      return saved ? readJson<{ agentConfigId: string | null }>(this.store, "config-git/message-agent.json") : { agentConfigId: null };
    });
  }
  saveMessageAgent(agentConfigId: string | null) {
    return this.coordinator.withWrite(() => {
      const setting = { agentConfigId };
      durableJson(this.store, "config-git/message-agent.json", setting);
      return setting;
    });
  }
  messageContext(token: string) {
    const entry = this.previews.get(token);
    check(entry?.kind === "commit" && entry.view.expiresAt > Date.now(), "PREVIEW_EXPIRED", "提交预览已过期", 409);
    // Only send already-redacted diff text, never raw repository/configuration data.
    return JSON.stringify([...entry.diffs, ...entry.cumulative]).slice(0, 60000);
  }
  async commit(input: Preference & { token: string; requestId: string }) {
    const intentPath = `config-git/commit-intents/${digest(input.requestId)}.json`;
    const inputHash = digest(canonicalJson(JSON.parse(JSON.stringify(input))));
    const saved = readOptional(this.store, intentPath);
    if (saved) {
      const intent = JSON.parse(saved) as { inputHash: string; revision: string; theme: SnapshotTheme; completed?: boolean };
      check(intent.inputHash === inputHash, "REQUEST_CONFLICT", "同一请求标识已用于不同确认参数", 409);
      const result = await this.repository.confirmCommit({ token: input.token, requestId: input.requestId, revision: intent.revision }, () => this.assertCommitRevision(intent.theme, intent.revision));
      if (!intent.completed) {
        if (this.restore.getGeneralTheme() !== intent.theme) this.restore.saveGeneralSnapshot(intent.theme);
        durableJson(this.store, intentPath, { ...intent, completed: true });
      }
      return result;
    }
    const entry = this.previews.get(input.token); check(entry?.kind === "commit" && entry.view.expiresAt > Date.now(), "PREVIEW_EXPIRED", "提交预览已过期", 409);
    const prefs = preference(input), recorded = entry.preference!;
    check(this.theme(input.theme) === recorded.theme && prefs.clientId === recorded.clientId && prefs.preferenceRevision === recorded.preferenceRevision, "PREVIEW_EXPIRED", "浏览器外观或偏好修订已变化，请重新预览", 409);
    const revision = entry.revision!;
    this.assertCommitRevision(recorded.theme!, revision);
    const result = await this.repository.confirmCommit({ token: input.token, requestId: input.requestId, revision }, () => {
      this.assertCommitRevision(recorded.theme!, revision);
      durableJson(this.store, intentPath, { inputHash, revision, theme: recorded.theme });
    });
    if (this.restore.getGeneralTheme() !== recorded.theme) this.restore.saveGeneralSnapshot(recorded.theme!);
    durableJson(this.store, intentPath, { inputHash, revision: entry.revision, theme: recorded.theme, completed: true });
    return result;
  }
  private assertCommitRevision(theme: SnapshotTheme, revision: string) {
    this.coordinator.withRead(() => {
      check(this.revision(theme) === revision, "PREVIEW_EXPIRED", "配置已变化，请重新预览", 409);
    });
  }
  private async context() {
    const binding = await this.repository.getBinding(); if (!binding) return { bindingId: null, head: null };
    const status = await this.repository.status(); check(!status.dirty, "DIRTY_REPOSITORY", "Git 工作目录有外部修改，请先处理", 409);
    return { bindingId: binding.id, head: status.head };
  }
  async restorePreview(input: RestorePreviewOptions & Preference & { source: NonNullable<RestorePreviewOptions["source"]> }) {
    preference(input);
    const context = await this.context();
    let snapshot: PortableSnapshot, recoveryMappings: Record<string, string> = {}, selected = input.categories;
    if (input.source.kind === "git") snapshot = parseSnapshot(await this.repository.readSnapshot(input.source.sha));
    else {
      const pointId = input.source.id;
      check(this.restore.recoveryPoints().some(p => p.id === pointId), "NOT_FOUND", "恢复点不存在", 404);
      const point = readJson<{ snapshot: PortableSnapshot; mappings: Record<string, string>; categories: SnapshotCategory[] }>(this.store, `config-git/recovery-points/${input.source.id}.json`);
      snapshot = point.snapshot; recoveryMappings = point.mappings; selected ??= point.categories;
    }
    return this.coordinator.withRead(async () => {
      const target = captureSnapshot(this.store, this.restore.getGeneralTheme() ?? "system"), selectedSet = new Set(selected ?? categories);
      check(selectedSet.size > 0 && [...selectedSet].every(c => categories.includes(c)), "INVALID_CATEGORY", "恢复类别无效", 422);
      if (selectedSet.has("workflows")) for (const w of snapshot.workflows) for (const source of [...w.versions, ...(w.draft ? [w.draft] : [])]) for (const dep of workflowDependencies(source.files)) {
        if (!this.store.one("SELECT id FROM script_versions WHERE id=? AND script_id=? AND status='published'", dep.versionId, dep.id)) selectedSet.add("scripts");
      }
      const scope = categories.filter(c => selectedSet.has(c));
      // Explicit input overrides current local values; persisted values fill genuinely absent bindings.
      const mappings = { ...this.savedMappings(), ...target.mappings, ...recoveryMappings, ...input.mappings };
      check(Object.values(mappings).every(v => typeof v === "string"), "LOCAL_MAPPING_INVALID", "本机映射必须为字符串", 422);
      const requiredMappings: PreviewView["requiredMappings"] = [];
      const requireRef = (key: string, label: string) => { if (!mappings[key]?.trim()) requiredMappings.push({ key, label }); };
      if (selectedSet.has("providers")) for (const p of snapshot.providers) requireRef(p.config.executable.localRef, `${p.id} executable`);
      if (selectedSet.has("webBridge")) for (const [app, envs] of Object.entries(snapshot.webBridge.environments)) for (const env of envs) for (const field of ["profileId", "extensionId"] as const) if (env[field]) requireRef(env[field].localRef, `${app}/${env.id} ${field}`);
      const secrets = [...this.localSecrets(), ...Object.values(mappings)], diffs: PreviewDiff[] = [], blockers: Blocker[] = [];
      const addDiff = (c: SnapshotCategory, id: string, before: unknown, after: unknown) => diffs.push({ ...safeDiff({ path: `${c}/${id}`, before: before === undefined ? null : canonicalJson(before), after: canonicalJson(after) }, secrets), category: c, objectId: id });
      for (const c of scope) {
        if (c === "general" || c === "webBridge") addDiff(c, c, target.snapshot[c], snapshot[c]);
        else for (const obj of snapshot[c]) addDiff(c, obj.id, target.snapshot[c].find(v => v.id === obj.id), obj);
      }
      for (const c of ["scripts", "workflows"] as const) if (selectedSet.has(c)) for (const obj of snapshot[c]) for (const v of obj.versions) {
        const script = this.store.one<{ script_id: string; status: string }>("SELECT script_id,status FROM script_versions WHERE id=?", v.id), workflow = this.store.one<{ workflow_id: string }>("SELECT workflow_id FROM workflow_versions WHERE id=?", v.id);
        let conflict = !!this.store.one("SELECT id FROM drafts WHERE id=?", v.id) || (c === "scripts" ? !!workflow || !!script && (script.script_id !== obj.id || script.status !== "published") : !!script || !!workflow && workflow.workflow_id !== obj.id);
        const incomingDigest = "definition" in v ? portableScriptHash(v.id, v.definition) : portableWorkflowHash(obj.id, v.id, v.files);
        let targetDigest: string | undefined;
        if (c === "scripts") { const previous = target.snapshot.scripts.find(s => s.id === obj.id)?.versions.find(x => x.id === v.id); if (previous) targetDigest = portableScriptHash(v.id, previous.definition); }
        else { const previous = target.snapshot.workflows.find(w => w.id === obj.id)?.versions.find(x => x.id === v.id); if (previous) targetDigest = portableWorkflowHash(obj.id, v.id, previous.files); }
        conflict ||= targetDigest !== undefined && targetDigest !== incomingDigest;
        if (conflict) { const message = `不可变版本冲突: ${c}/${obj.id}/${v.id}`; blockers.push({ code: "VERSION_ID_CONFLICT", category: c, objectId: obj.id, versionId: v.id, message, incomingDigest, targetDigest }); diffs.push({ category: c, objectId: obj.id, versionId: v.id, path: `${c}/${obj.id}/versions/${v.id}`, changeType: "conflict", blockingReason: message }); }
      }
      for (const required of requiredMappings) blockers.push({ code: "LOCAL_MAPPING_REQUIRED", message: `需要本机映射: ${required.label}` });
      let token: string = randomUUID(), expiresAt = Date.now() + 30 * 60_000, finalScope = scope;
      if (!blockers.length) {
        try {
          const preview = await this.restore.preview(snapshot, { ...input, categories: scope, mappings, context });
          token = preview.token; expiresAt = preview.expiresAt; finalScope = preview.categories;
          // Keep planned merge semantics, while exposing only the sanitized comparison data.
          for (const change of preview.changes) { const diff = diffs.find(d => d.category === change.category && d.objectId === change.objectId); if (diff) diff.changeType = change.changeType; }
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const message = `恢复预览校验失败 (${error.code})`; blockers.push({ code: error.code, message });
        }
      }
      const deliverGeneral = finalScope.includes("general") && (input.theme === undefined || input.theme !== snapshot.general.theme);
      const view: PreviewView = { token, expiresAt, categories: finalScope, diffs: [], blockers: blockers.map(b => b.message), blockerDetails: blockers, requiredMappings, ...(input.source.kind === "git" ? { sourceSha: input.source.sha } : {}), noChanges: !deliverGeneral && diffs.every(d => d.changeType === "same") };
      this.previews.set(token, { view, diffs, cumulative: [], kind: blockers.length ? "blocked" : "restore" });
      return this.previewPage(token);
    });
  }
  async apply(input: { requestId: string; token: string }) {
    const prior = this.restore.operations().find(item => item.requestId === input.requestId);
    if (!prior) {
      const entry = this.previews.get(input.token); check(entry && entry.kind === "restore" && entry.view.expiresAt > Date.now(), "PREVIEW_EXPIRED", "恢复计划未就绪或已过期，请重新预览", 409);
    }
    const result = await this.restore.apply(input.requestId, input.token, prior ? undefined : await this.context());
    check(result.phase === "completed", "RESTORE_FAILED", "配置恢复未完成", 409);
    return { operationId: result.operationId, requestId: result.requestId, phase: result.phase, recoveryPointId: result.recoveryPointId, source: result.source, result: result.result };
  }
  previewPage(token: string, cursor = "0") {
    const entry = this.previews.get(token); check(entry && entry.view.expiresAt > Date.now(), "PREVIEW_EXPIRED", "预览已过期", 409);
    check(/^\d+$/.test(cursor), "INVALID_PAGE", "无效分页", 422); const offset = Number(cursor);
    const all = [...entry.diffs.map(d => ({ ...d, scope: "current" as const })), ...entry.cumulative.map(d => ({ ...d, scope: "cumulative" as const }))];
    check(Number.isSafeInteger(offset) && offset >= 0 && offset <= all.length, "INVALID_PAGE", "无效分页", 422);
    const diffs: PreviewDiff[] = [], cumulativeDiffs: PreviewDiff[] = []; let bytes = 0, next = offset;
    for (; next < all.length && diffs.length + cumulativeDiffs.length < 50; next++) {
      const item = all[next]!, size = Buffer.byteLength(JSON.stringify(item));
      if (bytes && bytes + size > 256 * 1024) break;
      // A single large file is still returned completely, never silently replaced by an incomplete preview.
      (item.scope === "cumulative" ? cumulativeDiffs : diffs).push(item); bytes += size;
    }
    return { ...entry.view, diffs, cumulativeDiffs, nextCursor: next < all.length ? String(next) : undefined };
  }
  async history(input: { scope?: "local" | "remote"; source?: "local" | "remote"; startSha?: string; cursor?: string; offset?: string | number; limit?: number }) {
    const offset = Number(input.cursor ?? input.offset ?? 0); check(Number.isSafeInteger(offset) && offset >= 0, "INVALID_PAGE", "无效分页", 422);
    const history = await this.repository.history({ source: input.scope ?? input.source, startSha: input.startSha, offset, limit: input.limit ?? 20 });
    const items = [];
    for (const commit of history.commits) {
      let compatible = true, touched: SnapshotCategory[] = [];
      try { const snapshot = parseSnapshot(await this.repository.readSnapshot(commit.sha)); touched = categories.filter(c => c in snapshot); } catch { compatible = false; }
      const secrets = this.localSecrets();
      const text = (value: string) => safeDiff({ path: "general/history", before: null, after: value }, secrets).after!;
      items.push({ ...commit, message: text(commit.message), author: text(commit.author), compatible, categories: touched });
    }
    return { items, startSha: history.startSha, nextCursor: history.nextOffset === null ? undefined : String(history.nextOffset) };
  }
  recoveryPoints() {
    const active = this.restore.operations().filter(item => !["completed", "failed"].includes(item.phase));
    return { items: this.restore.recoveryPoints().map(item => ({ ...item, createdAt: new Date(item.createdAt).toISOString(), protected: active.some(operation => operation.recoveryPointId === item.id) })) };
  }
}
