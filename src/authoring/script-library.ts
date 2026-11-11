import { rmSync } from "node:fs";
import { ScriptJournal } from "../persistence/script-journal.js";
import { validateScriptDictionaries } from "../dictionaries/validation.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { Store } from "../persistence/store.js";
import { check } from "../domain/errors.js";
import { validateScript, type ScriptDefinition } from "../domain/scripts.js";
import { checkScriptSource } from "../runtime/script.js";
import type { ScriptVersion, Workflow } from "../domain/types.js";

export async function scriptDiagnostics(definition: ScriptDefinition, store?: Store): Promise<ScriptVersion["validation"]> {
  try { await checkScriptSource(definition); if (store) validateScriptDictionaries(store, definition); return { valid: true, diagnostics: [] }; }
  catch (error) { return { valid: false, diagnostics: [error instanceof Error ? error.message : "脚本校验失败"] }; }
}

export class ScriptLibrary {
  constructor(readonly store: Store) {}
  private replay<T>(scope: string, requestId: string | undefined, input: unknown): T | undefined {
    if (requestId === undefined) return undefined;
    check(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 200, "INVALID_REQUEST_ID", "缺少有效 requestId");
    if (this.store.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId)) {
      return this.store.command<T>(scope, requestId, input, () => { throw new Error("unreachable"); });
    }
  }
  private commit<T>(scope: string, requestId: string | undefined, input: unknown, action: () => T) {
    return configCoordinator(this.store).withWrite(() => {
      return requestId === undefined ? this.store.transaction(action) : this.store.command(scope, requestId, input, action);
    });
  }
  saveTree(definition: ScriptDefinition) {
    return configCoordinator(this.store).withWrite(() => {
      const { files, ...manifest } = definition;
      return this.store.files.saveScriptTree(files, { ...manifest, timeoutMs: definition.timeoutMs ?? 300000, resultMode: definition.resultMode ?? (definition.runtime === "shell" ? "process" : "json") });
    });
  }
  version(scriptId: string, versionId: string) {
    const version = this.store.scriptVersion(versionId), definition = this.store.scriptDefinition(scriptId, versionId);
    return { ...version, name: definition.name, description: definition.description, resultMode: definition.resultMode, ...(definition.dictionaryBindings ? { dictionaryBindings: definition.dictionaryBindings } : {}), files: definition.files, metadataSnapshot: !!this.store.files.readScriptTree(version.sourceRef).definition };
  }
  detail(scriptId: string) {
    const script = this.store.script(scriptId);
    const versions = this.store.scriptVersions(scriptId).map(version => {
      const { files, ...item } = this.version(scriptId, version.id);
      return item;
    });
    return { ...script, versions, draft: script.currentDraftVersionId ? this.version(scriptId, script.currentDraftVersionId) : null };
  }
  async create(input: ScriptDefinition & { requestId?: string }) {
    return configCoordinator(this.store).withActivity("ScriptLibrary.create", async () => {
      check(input !== null && typeof input === "object" && !Array.isArray(input), "INVALID_SCRIPT", "脚本定义必须是对象");
      const prior = this.replay<ReturnType<Store["createScript"]>>("script-create", input.requestId, input);
      if (prior) return prior;
      const definition = validateScript(input), validation = await scriptDiagnostics(definition, this.store), tree = this.saveTree(definition);
      return this.commit("script-create", input.requestId, input, () => this.store.createScript(definition, tree.path, tree.hash, validation));
    });
  }
  async update(scriptId: string, input: ScriptDefinition & { expectedRevision: number; expectedDraftVersionId?: string | null; requestId?: string }) {
    return configCoordinator(this.store).withActivity("ScriptLibrary.update", async () => {
      check(input !== null && typeof input === "object" && !Array.isArray(input), "INVALID_SCRIPT", "脚本定义必须是对象");
      check(input.id === undefined || input.id === scriptId, "IDENTITY_CONFLICT", "脚本身份不能修改", 409);
      const scope = `script-update:${scriptId}`;
      const prior = this.replay<ReturnType<Store["updateScriptDraft"]>>(scope, input.requestId, input);
      if (prior) return prior;
      check(Number.isInteger(input.expectedRevision) && input.expectedRevision >= 0, "INVALID_REQUEST", "草稿修订号无效");
      const definition = validateScript({ ...input, id: scriptId }), validation = await scriptDiagnostics(definition, this.store), tree = this.saveTree(definition);
      return this.commit(scope, input.requestId, input, () => {
        const script = this.store.script(scriptId);
        if (Object.hasOwn(input, "expectedDraftVersionId")) check(script.currentDraftVersionId === input.expectedDraftVersionId, "REVISION_CONFLICT", "草稿版本已改变，请刷新后重试", 409);
        return this.store.updateScriptDraft(scriptId, input.expectedRevision, definition, tree.path, tree.hash, validation);
      });
    });
  }
  async copy(scriptId: string, input: { id: string; name: string; versionId: string; requestId: string }) {
    return configCoordinator(this.store).withActivity("ScriptLibrary.copy", async () => {
      const scope = `script-copy:${scriptId}`, prior = this.replay<ReturnType<Store["createScript"]>>(scope, input.requestId, input);
      if (prior) return prior;
      const source = this.store.scriptDefinition(scriptId, input.versionId), definition = validateScript({ ...source, id: input.id, name: input.name });
      const validation = await scriptDiagnostics(definition, this.store), tree = this.saveTree(definition);
      return this.commit(scope, input.requestId, input, () => this.store.createScript(definition, tree.path, tree.hash, validation));
    });
  }
  async restore(scriptId: string, input: { versionId: string; expectedRevision: number; expectedDraftVersionId: string | null; replaceDraft: boolean; requestId: string }) {
    return configCoordinator(this.store).withActivity("ScriptLibrary.restore", async () => {
      const scope = `script-restore:${scriptId}`, prior = this.replay<ReturnType<Store["updateScriptDraft"]>>(scope, input.requestId, input);
      if (prior) return prior;
      const version = this.store.scriptVersion(input.versionId);
      check(version.scriptId === scriptId && version.status === "published", "INVALID_STATE", "只能还原已发布版本");
      const definition = this.store.scriptDefinition(scriptId, version.id), validation = await scriptDiagnostics(definition, this.store), tree = this.saveTree(definition);
      return this.commit(scope, input.requestId, input, () => {
        const script = this.store.script(scriptId);
        check(script.currentDraftVersionId === input.expectedDraftVersionId, "REVISION_CONFLICT", "草稿版本已改变，请刷新后重试", 409);
        check(!script.currentDraftVersionId || input.replaceDraft, "DRAFT_EXISTS", "已有草稿，确认替换后才能还原", 409);
        return this.store.updateScriptDraft(scriptId, input.expectedRevision, definition, tree.path, tree.hash, validation);
      });
    });
  }
  async publish(scriptId: string, input: { expectedRevision: number; requestId: string }) {
    return configCoordinator(this.store).withActivity("ScriptLibrary.publish", async () => {
      const scope = `script-publish:${scriptId}`;
      const prior = this.replay<ReturnType<Store["publishScript"]>>(scope, input.requestId, input);
      if (prior) return prior;
      const script = this.store.script(scriptId);
      if (script.currentDraftVersionId) {
        const draft = this.store.scriptVersion(script.currentDraftVersionId);
        await checkScriptSource({ runtime: script.runtime, entryFile: draft.entryFile, files: this.store.files.readScriptTree(draft.sourceRef).files });
      }
      return this.commit(scope, input.requestId, input, () => {
        const current = this.store.script(scriptId);
        if (current.currentDraftVersionId) validateScriptDictionaries(this.store, this.store.scriptDefinition(scriptId, current.currentDraftVersionId));
        return this.store.publishScript(scriptId, input.expectedRevision);
      });
    });
  }
  tests(scriptId: string, offset = 0, limit = 20) {
    this.store.script(scriptId);
    check(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 100, "INVALID_REQUEST", "测试分页参数无效");
    const total = this.store.one<{ total: number }>("SELECT COUNT(*) AS total FROM script_tests WHERE script_id=?", scriptId)!.total;
    const items = this.store.all("SELECT id,script_version_id AS scriptVersionId,draft_revision AS draftRevision,status,exit_code AS exitCode,duration_ms AS durationMs,created_at AS createdAt FROM script_tests WHERE script_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?", scriptId, limit, offset);
    const activeCount = this.store.one<{ total: number }>("SELECT COUNT(*) AS total FROM script_tests WHERE script_id=? AND status IN ('queued','running')", scriptId)!.total;
    return { items, total, activeCount };
  }
  delete(scriptId: string) {
    check(/^[a-z][a-z0-9-]{0,99}$/.test(scriptId), "INVALID_SCRIPT", "脚本 ID 无效");
    return configCoordinator(this.store).withWrite(() => {
      const result = this.store.transaction(() => {
        if (!this.store.one("SELECT id FROM scripts WHERE id=?", scriptId)) return { id: scriptId, deleted: true };
        check(!this.references(scriptId, true).items.length, "SCRIPT_REFERENCED", "脚本仍被工作流或草稿引用，请先移除引用；需要保留引用时可归档脚本", 409);
        check(!this.store.one("SELECT id FROM script_tests WHERE script_id=? AND status IN ('queued','running')", scriptId), "SCRIPT_BUSY", "脚本有排队或执行中的测试，请完成或取消后再删除", 409);
        check(!new ScriptJournal(this.store.files).list(scriptId).some(turn => ["queued", "running"].includes(turn.status)), "SCRIPT_BUSY", "脚本正在生成，请完成或取消后再删除", 409);
        this.store.exec("DELETE FROM script_tests WHERE script_id=?", scriptId);
        this.store.exec("UPDATE scripts SET current_draft_version_id=NULL,current_published_version_id=NULL WHERE id=?", scriptId);
        this.store.exec("DELETE FROM script_versions WHERE script_id=?", scriptId);
        this.store.exec("DELETE FROM scripts WHERE id=?", scriptId);
        const scopes = ["script-update", "script-copy", "script-restore", "script-publish", "script-test", "script-test-v2", "script-clean", "script-agent-confirm", "script-agent-apply"].map(scope => `${scope}:${scriptId}`);
        this.store.exec("DELETE FROM command_receipts WHERE scope IN (?,?,?,?,?,?,?,?,?) OR json_extract(result_json,'$.script.id')=?", ...scopes, scriptId);
        return { id: scriptId, deleted: true };
      });
      // Source trees and blobs are content-addressed and may be shared by other scripts.
      rmSync(this.store.files.path(`script-agent/${scriptId}`), { recursive: true, force: true });
      return result;
    });
  }
  references(scriptId: string, strict = false) {
    this.store.script(scriptId);
    const references: { workflowId: string; workflowName: string; versionId?: string; version?: number; draftId?: string; nodeId: string; scriptVersionId: string }[] = [];
    const collect = (workflow: Workflow, context: { versionId?: string; version?: number; draftId?: string }) => {
      for (const node of workflow.nodes) if (node.type === "script" && node.config.scriptId === scriptId) references.push({ workflowId: workflow.id, workflowName: workflow.name, ...context, nodeId: node.id, scriptVersionId: node.config.scriptVersionId! });
    };
    for (const row of this.store.all<{ id: string; version_no: number; definition_json: string }>("SELECT id,version_no,definition_json FROM workflow_versions")) collect(JSON.parse(row.definition_json), { versionId: row.id, version: row.version_no });
    for (const draft of this.store.drafts()) {
      if (draft.publishedVersionId) continue;
      try { collect(JSON.parse(this.store.files.readTree(draft.artifactPath).files["workflow.json"]!), { draftId: draft.id }); }
      catch {
        check(!strict, "REFERENCE_CHECK_FAILED", "无法验证工作流草稿的引用，已停止删除，请先修复草稿", 409);
        continue;
      }
    }
    return { items: references };
  }
}
