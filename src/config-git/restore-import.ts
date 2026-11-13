import { exportDictionaries, prepareDictionaries, importDictionaries, dictionaryChanged, dictionaryFingerprint, validateDictionaries, validateDictionaryPointers, requirements, authenticateDictionary } from "./dictionaries.js";
import { workflowDictionarySensitivity } from "../domain/dictionaries.js";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { canonicalJson, digest, checkFiles, compileScripts, readDefinition, readLayout, validateFiles } from "../persistence/files.js";
import type { SourceFiles, Workflow } from "../domain/types.js";
import type { ScriptDefinition } from "../domain/scripts.js";
import { validateScript } from "../domain/scripts.js";
import { checkScriptSource } from "../runtime/script.js";
import { schemaSubset, bindingSchema } from "../domain/schema-compatibility.js";
import { validateBridgeConfigV1 } from "../web-bridge/config-validation.js";
import { readConfiguredBridge } from "../web-bridge/configured.js";
import { BRIDGE_BINDINGS_PATH, migrateBrowserBindings, readBrowserBindings } from "../web-bridge/local-bindings.js";
import { DatabaseBridgeConfiguration, bridgeDeclaration } from "../web-bridge/database-config.js";
import { workspaceSchemaInstalled, assertNoMaintenanceTask } from "../agent/workspace-business-hooks.js";
import type { PortableSnapshot, PortableBridge, PortableProvider, PortableScript, PortableWorkflow, SnapshotCategory, SnapshotTheme, LocalRef } from "./snapshot-types.js";
import type { RestorePreview, RestorePreviewOptions } from "./restore.js";
import { persistArtifact, readOptional } from "./restore-files.js";
import { localReference, compareCodePoints } from "./snapshot-primitives.js";
import { gitProjects } from "../project-git/service.js";
import { portableScriptHash, portableWorkflowHash, normalizedScript, workflowDependencies, workflowIdentity, validatePortableScript } from "./snapshot-validation.js";

type Row = Record<string, any>;
type Validation = { valid: boolean; diagnostics: string[] };
interface ScriptImport { value: PortableScript; versions: { id: string; definition: ScriptDefinition; path: string; hash: string }[]; draft?: { id: string; definition: ScriptDefinition; path: string; hash: string; validation: Validation; changed: boolean; existing: boolean } }
interface WorkflowImport { value: PortableWorkflow; versions: { id: string; files: SourceFiles; path: string; hash: string; definition: Workflow }[]; draft?: { id: string; path: string; hash: string; validation: Validation; changed: boolean; existing: boolean } }
export interface PreparedImport {
  effective?: PortableSnapshot;
  dictionaries: NonNullable<PortableSnapshot["dictionaries"]>;
  categories: SnapshotCategory[]; changes: RestorePreview["changes"]; files: Record<string, string>;
  scripts: ScriptImport[]; workflows: WorkflowImport[]; providers: { value: Row; changed: boolean }[];
  agentModelConfigs: { value: NonNullable<PortableProvider["agentModelConfigs"]>[number] & { providerId: string }; changed: boolean }[];
  bridge?: { revision: number; contentHash: string; runtimeJson: string };
}
const categories: SnapshotCategory[] = ["general", "providers", "webBridge", "scripts", "workflows", "dictionaries"];
const ordered = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => compareCodePoints(a.id, b.id));
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function rawBridge(store: Store): Row { return readConfiguredBridge(store, true); }
function localValue(ref: LocalRef, existing: unknown, mappings: Record<string, string>) {
  const value = mappings[ref.localRef] ?? existing;
  check(typeof value === "string" && value.trim().length > 0, "LOCAL_MAPPING_REQUIRED", `需要本机映射: ${ref.localRef}`, 422);
  return value;
}
function draftRows(store: Store, id: string) {
  return store.all<Row>("SELECT * FROM drafts WHERE status != 'published'").filter(row => {
    const declared = workflowIdentity(store.files.readTree(row.artifact_path).files).id;
    return declared === id;
  });
}
export function assertIdle(store: Store) {
  if (workspaceSchemaInstalled(store)) assertNoMaintenanceTask(store);
  for (const table of ["runs", "script_tests", "authoring_turns"]) check(!store.one(`SELECT id FROM ${table} WHERE status IN ('queued','running','cancel_requested') LIMIT 1`), "CONFIG_BUSY", "存在未完成执行或生成活动", 409);
  check(!store.one("SELECT id FROM drafts WHERE status='publishing' LIMIT 1"), "CONFIG_BUSY", "工作流正在发布", 409);
}
export function databaseFingerprint(store: Store) {
  const rows = Object.fromEntries(["workflows", "workflow_versions", "drafts", "scripts", "script_versions", "provider_settings", "agent_model_configs", "dictionaries", "dictionary_versions"].map(table => [table, store.all<Row>(`SELECT * FROM ${table} ORDER BY id`)]));
  if (workspaceSchemaInstalled(store)) rows.bridge_configuration = store.all<Row>("SELECT * FROM bridge_configuration ORDER BY id");
  rows.agent_model_config_revisions = store.all<Row>("SELECT * FROM agent_model_config_revisions ORDER BY config_id,revision");
  const artifacts = [...rows.workflow_versions!, ...rows.drafts!].map(row => ({ path: row.artifact_path, content: store.files.readTree(row.artifact_path) }));
  const scriptArtifacts = rows.script_versions!.map(row => ({ path: row.source_ref, content: store.files.readScriptTree(row.source_ref) }));
  return digest(canonicalJson({ rows, artifacts, scriptArtifacts }));
}
export function targetFingerprint(store: Store) {
  return digest(canonicalJson({ keyring: dictionaryFingerprint(store), database: databaseFingerprint(store), bridge: workspaceSchemaInstalled(store) ? rawBridge(store) : readOptional(store, "config/web-bridge.json"), browserBindings: readOptional(store, BRIDGE_BINDINGS_PATH), general: readOptional(store, "config-git/general.json"), mappings: readOptional(store, "config-git/local-mappings.json"), projects: gitProjects(store).list(), sshReferences: gitProjects(store).profiles() }));
}
/** Independent source copies live inside the recovery point JSON, never just artifact paths. */
export function captureSnapshot(store: Store, theme: SnapshotTheme) {
  const mappings: Record<string, string> = {}, providers: PortableProvider[] = [];
  for (const row of store.all<Row>("SELECT * FROM provider_settings ORDER BY id")) {
    const config = JSON.parse(row.config_json), ref = localReference("providers", row.id, "executable");
    if (typeof config.executable === "string") mappings[ref.localRef] = config.executable;
    providers.push({ id: row.id, enabled: !!row.enabled, config: { executable: ref, transport: config.transport ?? "native" }, defaultModel: row.default_model, models: JSON.parse(row.models_json).map((model: Row) => ({ id: model.id, name: model.name, source: model.source ?? "configured", enabled: model.enabled ?? true, deleted: model.deleted ?? false })),
      agentModelConfigs: store.all<Row>("SELECT id,name,description,model_id AS modelId,enabled FROM agent_model_configs WHERE provider_id=? ORDER BY id", row.id).map(config => ({ id: config.id, name: config.name, description: config.description, modelId: config.modelId, enabled: !!config.enabled })) });
  }
  const bridge = rawBridge(store), webBridge: PortableBridge = { applications: bridge.applications, environments: {}, tools: bridge.tools, enabledTools: bridge.enabledTools };
  for (const [app, environments] of Object.entries(bridge.environments as Record<string, Row[]>)) webBridge.environments[app] = environments.map(env => {
    return { id: env.id, ...(env.key === undefined ? {} : { key: env.key }), origin: env.origin, enabled: env.enabled };
  });
  const scripts: PortableScript[] = store.scripts().map(script => ({ id: script.id, name: script.name, description: script.description, runtime: script.runtime, archived: script.status === "archived", currentPublishedVersionId: script.currentPublishedVersionId, draft: script.currentDraftVersionId ? scriptDefinitionUnchecked(store, script.id, script.currentDraftVersionId) : null, versions: store.scriptVersions(script.id).filter(version => version.status === "published").map(version => ({ id: version.id, definition: scriptDefinitionUnchecked(store, script.id, version.id) })) }));
  const workflows = new Map<string, PortableWorkflow>();
  for (const row of store.all<Row>("SELECT * FROM workflows")) workflows.set(row.id, { id: row.id, name: row.name, currentPublishedVersionId: row.current_version_id, draft: null, versions: store.all<Row>("SELECT * FROM workflow_versions WHERE workflow_id=?", row.id).map(version => ({ id: version.id, files: store.files.readTree(version.artifact_path).files })) });
  for (const row of store.all<Row>("SELECT * FROM drafts WHERE status != 'published'")) {
    const files = store.files.readTree(row.artifact_path).files, identity = workflowIdentity(files);
    const workflow = workflows.get(identity.id) ?? { ...identity, currentPublishedVersionId: null, draft: null, versions: [] };
    check(!workflow.draft, "IDENTITY_CONFLICT", `多个草稿声明同一工作流: ${identity.id}`, 409);
    workflow.draft = { files, baseVersionId: row.base_version_id }; workflows.set(identity.id, workflow);
  }
  return { snapshot: { dictionaries: exportDictionaries(store), general: { theme }, providers, webBridge, scripts, workflows: [...workflows.values()] } satisfies PortableSnapshot, mappings };
}
function scriptDefinitionUnchecked(store: Store, scriptId: string, versionId: string): ScriptDefinition {
  const script = store.script(scriptId), version = store.scriptVersion(versionId), tree = store.files.readScriptTree(version.sourceRef);
  return { id: scriptId, name: tree.definition?.name ?? script.name, description: tree.definition?.description ?? script.description, runtime: script.runtime, entryFile: version.entryFile, timeoutMs: version.timeoutMs, inputSchema: version.inputSchema, outputSchema: version.outputSchema, resultMode: tree.definition?.resultMode ?? (script.runtime === "shell" ? "process" : "json"), ...(tree.definition?.dictionaryBindings ? { dictionaryBindings: tree.definition.dictionaryBindings } : {}), files: tree.files };
}
function assertVersionIdentity(store: Store, id: string, kind: "script" | "workflow", owner: string) {
  check(!store.one("SELECT id FROM dictionary_versions WHERE id=?", id), "VERSION_ID_CONFLICT", "版本 ID 与字典版本碰撞", 409);
  check(!store.one("SELECT id FROM drafts WHERE id=?", id), "VERSION_ID_CONFLICT", `版本 ID 与草稿碰撞: ${id}`, 409);
  const script = store.one<Row>("SELECT * FROM script_versions WHERE id=?", id), workflow = store.one<Row>("SELECT * FROM workflow_versions WHERE id=?", id);
  check(!(kind === "script" ? workflow || script && (script.script_id !== owner || script.status !== "published") : script || workflow && workflow.workflow_id !== owner), "VERSION_ID_CONFLICT", `版本 ID 归属或类型冲突: ${id}`, 409);
}
export async function prepareImport(store: Store, snapshot: PortableSnapshot, options: RestorePreviewOptions): Promise<PreparedImport> {
  if (snapshot.dictionaries !== undefined) validateDictionaries(snapshot);
  const selected = new Set(options.categories ?? categories.filter(c => c !== "dictionaries" || snapshot.dictionaries !== undefined));
  check(selected.size > 0 && [...selected].every(item => categories.includes(item)), "INVALID_CATEGORY", "恢复类别无效");
  check(["light", "dark", "system"].includes(snapshot.general.theme), "INVALID_THEME", "外观值无效");
  const mappings = options.mappings ?? {}, result: PreparedImport = { dictionaries: [], categories: [], changes: [], files: {}, scripts: [], workflows: [], providers: [], agentModelConfigs: [] };
  const identities = new Set<string>(), versions = new Set<string>();
  for (const object of [...snapshot.scripts, ...snapshot.workflows, ...(snapshot.dictionaries ?? [])]) {
    check(!identities.has(object.id), "IDENTITY_CONFLICT", `重复对象身份: ${object.id}`, 409); identities.add(object.id);
    for (const version of object.versions) { check(!versions.has(version.id), "VERSION_ID_CONFLICT", `重复版本身份: ${version.id}`, 409); versions.add(version.id); }
  }
  if (selected.has("workflows")) {
    for (const workflow of snapshot.workflows) for (const source of [...workflow.versions, ...(workflow.draft ? [workflow.draft] : [])]) {
      for (const dependency of workflowDependencies(source.files)) {
        const target = store.one<Row>("SELECT * FROM script_versions WHERE id=? AND script_id=? AND status='published'", dependency.versionId, dependency.id);
        const script = snapshot.scripts.find(item => item.id === dependency.id), incoming = script?.versions.find(item => item.id === dependency.versionId);
        check(target || incoming, "DEPENDENCY_MISSING", `缺少脚本版本: ${dependency.id}/${dependency.versionId}`, 422);
        if (target && incoming) check(portableScriptHash(incoming.id, incoming.definition) === portableScriptHash(incoming.id, scriptDefinitionUnchecked(store, dependency.id, incoming.id)), "VERSION_ID_CONFLICT", `脚本依赖摘要冲突: ${incoming.id}`, 409);
        if (!target) selected.add("scripts");
      }
    }
  }
  if (selected.has("dictionaries")) check(snapshot.dictionaries !== undefined, "INVALID_CATEGORY", "此快照未提供字典类别", 422);
  for (const category of ["scripts", "workflows"] as const) if (selected.has(category)) for (const obj of snapshot[category]) {
    for (const r of requirements(snapshot, obj)) {
      const local = exportDictionaries(store).find(d => d.id === r.dictionaryId);
      const incoming = snapshot.dictionaries?.find(d => d.id === r.dictionaryId);
      if (!selected.has("dictionaries") && !local) { check(incoming, "DEPENDENCY_MISSING", "字典依赖缺失", 422); selected.add("dictionaries"); }
    }
  }
  if (selected.has("dictionaries")) { result.dictionaries = snapshot.dictionaries ?? []; prepareDictionaries(store, result.dictionaries); }
  for (const category of ["scripts", "workflows"] as const) if (selected.has(category)) for (const obj of snapshot[category]) for (const r of requirements(snapshot, obj)) {
    const d = (selected.has("dictionaries") ? result.dictionaries.find(d => d.id === r.dictionaryId) : undefined) ?? exportDictionaries(store).find(d => d.id === r.dictionaryId);
    const v = d?.versions.find(v => v.id === d.currentVersionId);
    check(d && v?.enabled && v.kind === r.kind && r.keys.every(k => Object.hasOwn(v.entries, k)), "DEPENDENCY_MISSING", "字典依赖不可用", 422);
    authenticateDictionary(store, d);
  }
  if (selected.has("workflows")) {
    const available = new Map(exportDictionaries(store).map(d => [d.id,d])); result.dictionaries.forEach(d => available.set(d.id,d));
    snapshot.workflows.forEach(w => validateDictionaryPointers(snapshot, w, [...available.values()]));
  }
  result.categories = categories.filter(item => selected.has(item));
  const change = (category: SnapshotCategory, objectId: string, exists: boolean, changed: boolean, detail?: string) => result.changes.push({ category, objectId, changeType: !exists ? "add" : changed ? "update" : "same", ...(detail ? { detail } : {}) });
  for (const d of result.dictionaries) change("dictionaries", d.id, !!store.one("SELECT id FROM dictionaries WHERE id=?", d.id), dictionaryChanged(store, d));
  if (selected.has("providers")) for (const provider of snapshot.providers) {
    check(provider.id === "pi-cli" || provider.id === "codex-cli", "UNKNOWN_PROVIDER", `不支持的 Provider: ${provider.id}`, 422);
    check(Object.keys(provider.config).every(key => ["executable", "transport"].includes(key)), "INVALID_PROVIDER_CONFIG", "Provider 配置含未知字段");
    check(provider.config.transport === "legacy" || provider.config.transport === "native", "INVALID_PROVIDER_CONFIG", "Provider transport 无效");
    check(!store.one("SELECT id FROM dictionaries WHERE id=?", provider.id) && !store.one("SELECT id FROM scripts WHERE id=?", provider.id) && !store.one("SELECT id FROM workflows WHERE id=?", provider.id) && !draftRows(store, provider.id).length, "IDENTITY_CONFLICT", `对象类型冲突: ${provider.id}`, 409);
    const previous = store.provider(provider.id), executable = localValue(provider.config.executable, previous?.config.executable, mappings);
    const models = new Map((previous?.models ?? []).map(model => [model.id, model]));
    for (const model of provider.models) models.set(model.id, model);
    const defaultModel = models.get(provider.defaultModel);
    check(!provider.defaultModel || defaultModel && defaultModel.enabled !== false && !defaultModel.deleted, "DEPENDENCY_MISSING", `默认模型不可用: ${provider.id}`, 422);
    const value = { id: provider.id, enabled: provider.enabled, config: { executable, transport: "native" }, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), defaultModel: provider.defaultModel };
    const changed = !previous || !equal(value, { id: previous.id, enabled: previous.enabled, config: previous.config, models: [...previous.models].sort((a, b) => a.id.localeCompare(b.id)), defaultModel: previous.defaultModel });
    result.providers.push({ value, changed }); change("providers", provider.id, !!previous, changed);
    for (const config of provider.agentModelConfigs ?? []) {
      const current = store.one<Row>("SELECT id,name,description,provider_id AS providerId,model_id AS modelId,enabled FROM agent_model_configs WHERE id=?", config.id);
      const value = { ...config, providerId: provider.id };
      const duplicate = result.agentModelConfigs.find(item => item.value.name.toLowerCase() === value.name.toLowerCase() && item.value.id !== value.id);
      const collision = store.one<Row>("SELECT id FROM agent_model_configs WHERE name=? COLLATE NOCASE AND id<>?", value.name, value.id);
      check(!duplicate && !collision, "AGENT_CONFIG_NAME_CONFLICT", `模型配置名称已存在: ${value.name}`, 409);
      const changed = !current || !equal(value, { ...current, enabled: !!current.enabled });
      result.agentModelConfigs.push({ value, changed });
      if (changed) change("providers", config.id, !!current, true, "Agent 模型配置");
    }
  }
  let bridge = rawBridge(store);
  if (selected.has("webBridge")) {
    const before = canonicalJson(bridge); bridge = structuredClone(bridge);
    const bindings = readBrowserBindings(store.root), priorBindings = canonicalJson(bindings);
    migrateBrowserBindings(bindings, bridge.environments);
    if (canonicalJson(bindings) !== priorBindings) result.files[BRIDGE_BINDINGS_PATH] = JSON.stringify(bindings);
    // The restore plan contains shared definitions only. Local bindings survive independently.
    for (const environments of Object.values(bridge.environments) as Row[][]) for (const environment of environments) { delete environment.profileId; delete environment.extensionId; }
    Object.assign(bridge.applications, snapshot.webBridge.applications); Object.assign(bridge.tools, snapshot.webBridge.tools); Object.assign(bridge.enabledTools, snapshot.webBridge.enabledTools);
    for (const [app, environments] of Object.entries(snapshot.webBridge.environments)) {
      const list = new Map<string, Row>((bridge.environments[app] ?? []).map((env: Row) => [env.id, env]));
      for (const env of environments) {
        const previous = list.get(env.id), key = env.key ?? previous?.key;
        const next: Row = { ...previous, id: env.id, ...(key === undefined ? {} : { key }), origin: env.origin, enabled: env.enabled, bound: false, tabAvailable: false };
        // Historical localRef fields are intentionally ignored, including explicit restore mappings.
        list.set(env.id, next);
      }
      bridge.environments[app] = [...list.values()];
    }
    for (const environments of Object.values(bridge.environments) as Row[][]) for (const environment of environments) { environment.bound = false; environment.tabAvailable = false; }
    validateBridgeConfigV1(JSON.stringify(bridge));
    if (workspaceSchemaInstalled(store)) {
      const row = store.one<{ revision: number; content_hash: string }>("SELECT revision,content_hash FROM bridge_configuration WHERE id='current'");
      check(row, "BRIDGE_CONFIG_INVALID", "浏览器数据库配置缺失", 503);
      result.bridge = { revision: row.revision, contentHash: row.content_hash, runtimeJson: JSON.stringify(bridge) };
    } else result.files["config/web-bridge.json"] = JSON.stringify(bridge);
    change("webBridge", "webBridge", true, before !== canonicalJson(bridge));
  }
  if (Object.keys(mappings).length) result.files["config-git/local-mappings.json"] = JSON.stringify({ ...JSON.parse(readOptional(store, "config-git/local-mappings.json") ?? "{}"), ...mappings });
  if (selected.has("scripts")) for (const script of ordered(snapshot.scripts)) {
    check(!store.one("SELECT id FROM dictionaries WHERE id=?", script.id) && !store.one("SELECT id FROM workflows WHERE id=?", script.id) && !store.provider(script.id) && !draftRows(store, script.id).length, "IDENTITY_CONFLICT", `对象类型冲突: ${script.id}`, 409);
    const previous = store.one<Row>("SELECT * FROM scripts WHERE id=?", script.id);
    check(!previous || previous.runtime === script.runtime, "IDENTITY_CONFLICT", `脚本运行时不可变: ${script.id}`, 409);
    const item: ScriptImport = { value: script, versions: [] };
    for (const version of ordered(script.versions)) {
      assertVersionIdentity(store, version.id, "script", script.id);
      check(version.definition.id === script.id && version.definition.runtime === script.runtime, "IDENTITY_CONFLICT", `脚本定义身份冲突: ${version.id}`);
      const definition = normalizedScript(validateScript(version.definition)); await checkScriptSource(definition);
      const existing = store.one<Row>("SELECT * FROM script_versions WHERE id=?", version.id);
      if (existing) check(portableScriptHash(version.id, definition) === portableScriptHash(version.id, scriptDefinitionUnchecked(store, script.id, version.id)), "VERSION_ID_CONFLICT", `不可变脚本内容冲突: ${version.id}`, 409);
      else { const { files, ...metadata } = definition, tree = persistArtifact(store, store.files.saveScriptTree(files, metadata)); item.versions.push({ id: version.id, definition, ...tree }); }
    }
    if (script.currentPublishedVersionId) check(script.versions.some(version => version.id === script.currentPublishedVersionId) || store.one("SELECT id FROM script_versions WHERE id=? AND script_id=? AND status='published'", script.currentPublishedVersionId, script.id), "DEPENDENCY_MISSING", `脚本发布指针无效: ${script.id}`);
    if (script.draft) {
      validatePortableScript(script.draft, false, snapshot.dictionaries !== undefined); check(script.draft.id === script.id && script.draft.runtime === script.runtime, "IDENTITY_CONFLICT", "脚本草稿身份冲突");
      const definition = normalizedScript(script.draft), { files, ...metadata } = definition, tree = persistArtifact(store, store.files.saveScriptTree(files, metadata));
      let validation: Validation;
      try { validateScript(definition); await checkScriptSource(definition); validation = { valid: true, diagnostics: [] }; } catch (error) { validation = { valid: false, diagnostics: [error instanceof Error ? error.message : "草稿待修复"] }; }
      const existing = previous?.current_draft_version_id as string | undefined;
      item.draft = { id: existing ?? randomUUID(), definition, ...tree, validation, existing: !!existing, changed: !existing || portableScriptHash("draft", definition) !== portableScriptHash("draft", scriptDefinitionUnchecked(store, script.id, existing)) };
    }
    result.scripts.push(item);
    change("scripts", script.id, !!previous, !previous || item.versions.length > 0 || !!item.draft?.changed || previous.name !== script.name || previous.description !== script.description || (previous.status === "archived") !== script.archived || !!script.currentPublishedVersionId && previous.current_published_version_id !== script.currentPublishedVersionId, `${script.draft ? "覆盖草稿" : "保留目标草稿"}；${script.currentPublishedVersionId ? "应用发布指针" : "保留目标发布指针"}`);
  }
  const scriptDefinition = (id: string, versionId: string) => {
    const planned = result.scripts.find(item => item.value.id === id)?.value.versions.find(version => version.id === versionId);
    if (planned) return planned.definition;
    const row = store.one<Row>("SELECT * FROM script_versions WHERE id=? AND script_id=? AND status='published'", versionId, id);
    check(row, "DEPENDENCY_MISSING", `缺少脚本版本: ${id}/${versionId}`, 422); return scriptDefinitionUnchecked(store, id, versionId);
  };
  const dependencies = (files: SourceFiles, strict: boolean) => {
    const raw = JSON.parse(files["workflow.json"]!) as { nodes?: { type?: string; config?: { script?: unknown } }[] };
    if (Array.isArray(raw.nodes)) for (const node of raw.nodes) if ((node?.type === "code.nodejs" || node?.type === "shell") && typeof node.config?.script === "string") check(Object.hasOwn(files, node.config.script), "INVALID_FILES", `缺少工作流源码: ${node.config.script}`);
    for (const dependency of workflowDependencies(files)) scriptDefinition(dependency.id, dependency.versionId);
    // Even incomplete drafts must not import dangling local project references.
    const projectNodes = (Array.isArray(raw.nodes) ? raw.nodes : []) as { type?: string; config?: { project?: { projectId?: string } } }[];
    for (const node of projectNodes) if (node?.type === "agent" && node.config?.project) {
      check(typeof node.config.project.projectId === "string", "DEPENDENCY_MISSING", "项目依赖无效");
      gitProjects(store).binding(node.config.project.projectId);
    }
    if (!strict) return;
    const workflow = readDefinition(files);
    // Structural security applies to every published version, including retained history.
    workflowDictionarySensitivity(workflow, scriptDefinition);
    for (const node of workflow.nodes) {
      if (node.type === "script") {
        const definition = scriptDefinition(node.config.scriptId!, node.config.scriptVersionId!);
        check(schemaSubset(bindingSchema(node.input, workflow), definition.inputSchema) !== "incompatible" && schemaSubset(node.outputSchema, definition.outputSchema) !== "incompatible" && (node.inputSchema === undefined || schemaSubset(node.inputSchema, definition.inputSchema) !== "incompatible"), "SCRIPT_CONTRACT_MISMATCH", `脚本契约不匹配: ${node.id}`);
      }
      if (node.type === "agent") {
        const configId = node.config.agentConfigId ?? workflow.defaults?.agent?.agentConfigId;
        const planned = result.agentModelConfigs.find(item => item.value.id === configId)?.value;
        const config = planned ? { enabled: planned.enabled, provider_id: planned.providerId, model_id: planned.modelId } : configId ? store.one<Row>("SELECT * FROM agent_model_configs WHERE id=?", configId) : undefined;
        check(config?.enabled, "DEPENDENCY_MISSING", `缺少 Agent 模型配置: ${configId ?? node.id}`, 422);
        const provider = result.providers.find(item => item.value.id === config.provider_id)?.value ?? store.provider(config.provider_id);
        check(provider && provider.enabled, "DEPENDENCY_MISSING", `缺少 Provider 定义: ${config.provider_id}`, 422);
        check(provider.models.some((item: Row) => item.id === config.model_id && item.enabled !== false && !item.deleted), "DEPENDENCY_MISSING", `缺少模型定义: ${node.id}`, 422);
      }
      if (node.type === "web-bridge") {
        const app = node.config.application, key = `${app}/${node.config.tool}`;
        check(app && bridge.applications[app]?.enabled && bridge.tools[key] && bridge.enabledTools[key] !== false, "DEPENDENCY_MISSING", `缺少 Bridge 工具定义: ${node.id}`, 422);
      }
    }
  };
  if (selected.has("workflows")) for (const workflow of ordered(snapshot.workflows)) {
    check(!store.one("SELECT id FROM dictionaries WHERE id=?", workflow.id) && !store.one("SELECT id FROM scripts WHERE id=?", workflow.id) && !store.provider(workflow.id), "IDENTITY_CONFLICT", `对象类型冲突: ${workflow.id}`, 409);
    check(workflow.draft || workflow.versions.length || workflow.currentPublishedVersionId || store.one("SELECT id FROM workflows WHERE id=?", workflow.id), "INVALID_SNAPSHOT", `工作流没有可恢复定义: ${workflow.id}`);
    const previous = store.one<Row>("SELECT * FROM workflows WHERE id=?", workflow.id), drafts = draftRows(store, workflow.id);
    check(drafts.length <= 1, "IDENTITY_CONFLICT", `多个目标草稿声明同一工作流: ${workflow.id}`, 409);
    const item: WorkflowImport = { value: workflow, versions: [] };
    for (const version of ordered(workflow.versions)) {
      assertVersionIdentity(store, version.id, "workflow", workflow.id); checkFiles(version.files);
      const definition = readDefinition(version.files); check(definition.id === workflow.id, "IDENTITY_CONFLICT", "工作流身份不匹配"); readLayout(version.files); dependencies(version.files, true);
      const compiled = await compileScripts(version.files, definition, { requireDefaultExport: true });
      const existing = store.one<Row>("SELECT * FROM workflow_versions WHERE id=?", version.id);
      if (existing) check(portableWorkflowHash(workflow.id, version.id, version.files) === portableWorkflowHash(workflow.id, version.id, store.files.readTree(existing.artifact_path).files), "VERSION_ID_CONFLICT", `不可变工作流内容冲突: ${version.id}`, 409);
      else { const tree = persistArtifact(store, store.files.saveTree(version.files, compiled)); item.versions.push({ id: version.id, files: version.files, definition, ...tree }); }
    }
    for (const pointer of [workflow.currentPublishedVersionId, workflow.draft?.baseVersionId]) if (pointer) check(workflow.versions.some(version => version.id === pointer) || store.one("SELECT id FROM workflow_versions WHERE id=? AND workflow_id=?", pointer, workflow.id), "DEPENDENCY_MISSING", `工作流发布/基线指针无效: ${workflow.id}`, 422);
    if (workflow.draft) {
      checkFiles(workflow.draft.files); readLayout(workflow.draft.files); check(workflowIdentity(workflow.draft.files).id === workflow.id, "IDENTITY_CONFLICT", "工作流草稿身份不匹配"); dependencies(workflow.draft.files, false);
      const tree = persistArtifact(store, store.files.saveTree(workflow.draft.files)), existing = drafts[0];
      item.draft = { id: existing?.id ?? randomUUID(), ...tree, validation: await validateFiles(workflow.draft.files), existing: !!existing, changed: !existing || existing.base_version_id !== workflow.draft.baseVersionId || !equal(store.files.readTree(existing.artifact_path).files, workflow.draft.files) };
    }
    result.workflows.push(item);
    change("workflows", workflow.id, !!previous || drafts.length > 0, !previous && !drafts.length || item.versions.length > 0 || !!item.draft?.changed || !!previous && previous.name !== workflow.name || !!workflow.currentPublishedVersionId && previous?.current_version_id !== workflow.currentPublishedVersionId, `${workflow.draft ? "覆盖草稿" : "保留目标草稿"}；${workflow.currentPublishedVersionId ? "应用发布指针" : "保留目标发布指针"}`);
  }
  if (selected.has("general")) { const raw = readOptional(store, "config-git/general.json"); change("general", "general", !!raw, !raw || JSON.parse(raw).theme !== snapshot.general.theme); }
  const effective: PortableSnapshot = structuredClone(captureSnapshot(store, snapshot.general.theme).snapshot);
  if (selected.has("general")) effective.general = snapshot.general;
  for (const c of ["scripts", "workflows", "dictionaries"] as const) if (selected.has(c)) {
    const merged = new Map<string, any>((effective[c] ?? []).map(v => [v.id, v]));
    for (const incoming of snapshot[c] ?? []) {
      const old = merged.get(incoming.id);
      if (c === "dictionaries") merged.set(incoming.id, incoming);
      else { const value = incoming as PortableScript | PortableWorkflow; const versions = new Map((old?.versions ?? []).map((v: any) => [v.id, v])); value.versions.forEach(v => versions.set(v.id, v)); merged.set(incoming.id, { ...value, versions: [...versions.values()], draft: value.draft ?? old?.draft ?? null, currentPublishedVersionId: value.currentPublishedVersionId ?? old?.currentPublishedVersionId ?? null }); }
    }
    (effective[c] as unknown[]) = [...merged.values()];
  }
  if (selected.has("providers")) for (const p of snapshot.providers) {
    const old = effective.providers.find(v => v.id === p.id), item = result.providers.find(v => v.value.id === p.id)!;
    const configs = new Map((old?.agentModelConfigs ?? []).map(v => [v.id,v])); (p.agentModelConfigs ?? []).forEach(v => configs.set(v.id,v));
    const next = { ...p, config: { ...p.config, transport: "native" as const }, models: item.value.models, agentModelConfigs: [...configs.values()] };
    effective.providers = [...effective.providers.filter(v => v.id !== p.id), next];
  }
  if (selected.has("webBridge")) {
    const old = effective.webBridge, incoming = snapshot.webBridge;
    old.applications = { ...old.applications, ...incoming.applications }; old.tools = { ...old.tools, ...incoming.tools }; old.enabledTools = { ...old.enabledTools, ...incoming.enabledTools };
    for (const [app, envs] of Object.entries(incoming.environments)) {
      const list = new Map((old.environments[app] ?? []).map(v => [v.id,v]));
      envs.forEach(({ profileId: _profile, extensionId: _extension, ...v }) => list.set(v.id, { ...list.get(v.id), ...v }));
      old.environments[app] = [...list.values()];
    }
  }
  result.effective = effective;
  return result;
}

/** Synchronous, called only inside the enclosing Store.command transaction. */
export function importDefinitions(store: Store, plan: PreparedImport) {
  if (plan.bridge) {
    check(workspaceSchemaInstalled(store), "PREVIEW_EXPIRED", "配置事实源已变化，请重新预览", 409);
    const backend = new DatabaseBridgeConfiguration(store); backend.read();
    const current = store.one<{ revision: number; content_hash: string }>("SELECT revision,content_hash FROM bridge_configuration WHERE id='current'");
    check(current?.revision === plan.bridge.revision && current.content_hash === plan.bridge.contentHash, "PREVIEW_EXPIRED", "浏览器配置已变化，请重新预览", 409);
    bridgeDeclaration(plan.bridge.runtimeJson); backend.write(plan.bridge.runtimeJson);
  }
  importDictionaries(store, plan.dictionaries);
  const now = Date.now();
  for (const { value, changed } of plan.providers) if (changed) {
    const previous = store.provider(value.id);
    store.exec("INSERT INTO provider_settings VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,config_json=excluded.config_json,models_json=excluded.models_json,default_model=excluded.default_model,revision=excluded.revision,updated_at=excluded.updated_at", value.id, value.enabled ? 1 : 0, JSON.stringify(value.config), JSON.stringify(value.models), value.defaultModel, (previous?.revision ?? 0) + 1, now);
  }
  for (const { value, changed } of plan.agentModelConfigs) if (changed) {
    const current = store.one<Row>("SELECT revision FROM agent_model_configs WHERE id=?", value.id);
    const revision = Number(current?.revision ?? 0) + 1;
    store.exec("INSERT INTO agent_model_configs VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,provider_id=excluded.provider_id,model_id=excluded.model_id,enabled=excluded.enabled,revision=excluded.revision,updated_at=excluded.updated_at", value.id, value.name, value.description, value.providerId, value.modelId, value.enabled ? 1 : 0, revision, now, now);
    store.exec("INSERT INTO agent_model_config_revisions VALUES(?,?,?,?,?,?,?,?)", value.id, revision, value.name, value.description, value.providerId, value.modelId, value.enabled ? 1 : 0, now);
  }
  for (const item of plan.scripts) {
    const value = item.value;
    store.exec("INSERT OR IGNORE INTO scripts(id,name,description,runtime,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", value.id, value.name, value.description, value.runtime, "draft", now, now);
    for (const version of item.versions) {
      const number = Number(store.one("SELECT COALESCE(MAX(version_no),0)+1 n FROM script_versions WHERE script_id=?", value.id)!.n), d = version.definition;
      store.exec("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at,published_at) VALUES(?,?,?,'published',0,?,?,?,?,?,?,?,?,?,?)", version.id, value.id, number, d.entryFile, d.timeoutMs!, JSON.stringify(d.inputSchema), JSON.stringify(d.outputSchema), version.path, version.hash, JSON.stringify({ valid: true, diagnostics: [] }), now, now, now);
    }
    if (item.draft?.changed) {
      const draft = item.draft, d = draft.definition;
      if (draft.existing) store.exec("UPDATE script_versions SET revision=revision+1,entry_file=?,timeout_ms=?,input_schema_json=?,output_schema_json=?,source_ref=?,content_hash=?,validation_json=?,updated_at=? WHERE id=? AND status='draft'", d.entryFile, d.timeoutMs!, JSON.stringify(d.inputSchema), JSON.stringify(d.outputSchema), draft.path, draft.hash, JSON.stringify(draft.validation), now, draft.id);
      else { const number = Number(store.one("SELECT COALESCE(MAX(version_no),0)+1 n FROM script_versions WHERE script_id=?", value.id)!.n); store.exec("INSERT INTO script_versions(id,script_id,version_no,status,revision,entry_file,timeout_ms,input_schema_json,output_schema_json,source_ref,content_hash,validation_json,created_at,updated_at) VALUES(?,?,?,'draft',0,?,?,?,?,?,?,?,?,?)", draft.id, value.id, number, d.entryFile, d.timeoutMs!, JSON.stringify(d.inputSchema), JSON.stringify(d.outputSchema), draft.path, draft.hash, JSON.stringify(draft.validation), now, now); }
    }
    const previous = store.script(value.id), published = value.currentPublishedVersionId ?? previous.currentPublishedVersionId;
    if (plan.changes.find(change => change.category === "scripts" && change.objectId === value.id)?.changeType !== "same") store.exec("UPDATE scripts SET name=?,description=?,status=?,current_draft_version_id=?,current_published_version_id=?,updated_at=?,archived_at=? WHERE id=?", value.name, value.description, value.archived ? "archived" : published ? "published" : "draft", item.draft?.id ?? previous.currentDraftVersionId, published, now, value.archived ? previous.archivedAt ?? now : null, value.id);
  }
  for (const item of plan.workflows) {
    const value = item.value;
    if (value.versions.length || value.currentPublishedVersionId) store.exec("INSERT OR IGNORE INTO workflows(id,name,created_at,updated_at) VALUES(?,?,?,?)", value.id, value.name, now, now);
    for (const version of item.versions) {
      const number = Number(store.one("SELECT COALESCE(MAX(version_no),0)+1 n FROM workflow_versions WHERE workflow_id=?", value.id)!.n);
      store.exec("INSERT INTO workflow_versions VALUES(?,?,?,?,?,?,?,?)", version.id, value.id, number, JSON.stringify(version.definition), JSON.stringify(readLayout(version.files)), version.path, version.hash, now);
    }
    const previous = store.one<Row>("SELECT * FROM workflows WHERE id=?", value.id);
    if (item.draft?.changed) {
      const draft = item.draft;
      if (draft.existing) store.exec("UPDATE drafts SET workflow_id=?,base_version_id=?,revision=revision+1,artifact_path=?,validation_json=?,status='draft',updated_at=? WHERE id=?", previous ? value.id : null, value.draft!.baseVersionId, draft.path, JSON.stringify(draft.validation), now, draft.id);
      else store.exec("INSERT INTO drafts VALUES(?,?,?,0,?,?,NULL,'draft',?,?)", draft.id, previous ? value.id : null, value.draft!.baseVersionId, draft.path, JSON.stringify(draft.validation), now, now);
    }
    if (previous && plan.changes.find(change => change.category === "workflows" && change.objectId === value.id)?.changeType !== "same") store.exec("UPDATE workflows SET name=?,current_version_id=?,updated_at=? WHERE id=?", value.name, value.currentPublishedVersionId ?? previous.current_version_id, now, value.id);
  }
}
