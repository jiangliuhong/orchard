import { check } from "../domain/errors.js";
import { transformSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { validateScript, type ScriptDefinition } from "../domain/scripts.js";
import { validateWorkflow } from "../domain/validation.js";
import { checkFiles, readLayout } from "../persistence/files.js";
import { validateBridgeConfigV1 } from "../migrations/config.js";
import type { SourceFiles } from "../domain/types.js";
import type { PortableSnapshot, PortableBridge, SnapshotDependency } from "./snapshot-types.js";
import { array, bool, canonicalSnapshotJson, compareCodePoints, encodeSnapshotId, localReference, normalizeSnapshotText, object, parseSnapshotJson, snapshotDigest, snapshotPath, string, unique } from "./snapshot-primitives.js";

function validateSourceSyntax(files: SourceFiles): void {
  for (const [path, source] of Object.entries(files)) {
    if (/\.(?:ts|js|mjs)$/.test(path)) {
      try { transformSync(source, { loader: path.endsWith(".ts") ? "ts" : "js", target: "node24", logLevel: "silent" }); }
      catch { check(false, "INVALID_SCRIPT", `Invalid script syntax: ${path}`); }
    } else if (path.endsWith(".sh")) {
      const syntax = spawnSync("/bin/bash", ["--noprofile", "--norc", "-n"], { input: source, env: { PATH: "/usr/bin:/bin" }, timeout: 2000, maxBuffer: 65536 });
      check(!syntax.error && syntax.status === 0, "INVALID_SCRIPT", `Invalid shell syntax: ${path}`);
    }
  }
}
export function normalizedSource(files: SourceFiles): SourceFiles {
  object(files); return Object.fromEntries(Object.keys(files).sort(compareCodePoints).map(path => [snapshotPath(path), normalizeSnapshotText(files[path]!)]));
}
export function normalizedScript(definition: ScriptDefinition): ScriptDefinition {
  return { ...definition, timeoutMs: definition.timeoutMs ?? 300000, resultMode: definition.resultMode ?? (definition.runtime === "shell" ? "process" : "json"), files: normalizedSource(definition.files) };
}
export function portableScriptHash(versionId: string, definition: ScriptDefinition): string {
  return snapshotDigest(canonicalSnapshotJson({ versionId, definition: normalizedScript(definition) }));
}
export function portableWorkflowHash(workflowId: string, versionId: string, files: SourceFiles): string {
  const sources = normalizedSource(files);
  const workflow = parseSnapshotJson(sources["workflow.json"]!), layout = parseSnapshotJson(sources["layout.json"] ?? "{}");
  delete sources["workflow.json"]; delete sources["layout.json"];
  return snapshotDigest(canonicalSnapshotJson({ workflowId, versionId, workflow, layout, sources }));
}
function identity(value: unknown): asserts value is string { string(value); encodeSnapshotId(value); }
function nullableId(value: unknown) { if (value !== null) identity(value); }
function ref(value: unknown, expected: { localRef: string }) { const r = object(value, ["localRef"]); check(r.localRef === expected.localRef, "INVALID_LOCAL_REF", "Local reference does not match its object and field"); }
const scriptFields = ["id", "name", "description", "runtime", "entryFile", "inputSchema", "outputSchema", "files"];
export function validatePortableScript(value: unknown, published: boolean): asserts value is ScriptDefinition {
  const d = object(value, scriptFields, ["timeoutMs", "resultMode"]);
  identity(d.id); for (const k of ["name", "description", "entryFile"]) string(d[k]);
  check(d.runtime === "nodejs" || d.runtime === "shell", "INVALID_SNAPSHOT", "Invalid runtime");
  check(d.timeoutMs === undefined || Number.isInteger(d.timeoutMs) && Number(d.timeoutMs) >= 1000 && Number(d.timeoutMs) <= 300000, "INVALID_SNAPSHOT", "Invalid script timeout");
  check(d.resultMode === undefined || d.resultMode === "json" || d.resultMode === "process", "INVALID_SNAPSHOT", "Invalid result mode");
  const files = normalizedSource(object(d.files) as SourceFiles);
  check(Object.keys(files).length > 0 && Object.keys(files).length <= 100 && Object.hasOwn(files, d.entryFile as string), "INVALID_FILES", "Missing script entry or source file limit");
  let total = 0;
  for (const [path, text] of Object.entries(files)) {
    check(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/.test(path) && !path.includes("..") && (d.runtime === "shell" ? path.endsWith(".sh") : /\.(ts|js|mjs)$/.test(path)), "INVALID_PATH", "Invalid script source path");
    const bytes = Buffer.byteLength(text); check(bytes <= 1024 * 1024, "SNAPSHOT_LIMIT", "Script source exceeds 1 MiB"); total += bytes;
  }
  check(total <= 4 * 1024 * 1024, "SNAPSHOT_LIMIT", "Script source exceeds 4 MiB");
  if (published) { validateScript(value); validateSourceSyntax(files); }
}
export function workflowIdentity(files: SourceFiles): { id: string; name: string } {
  const w = object(parseSnapshotJson(files["workflow.json"]!)); identity(w.id); string(w.name); return { id: w.id, name: w.name };
}
export function workflowDependencies(files: SourceFiles): { id: string; versionId: string }[] {
  const w = object(parseSnapshotJson(files["workflow.json"]!));
  if (!Array.isArray(w.nodes)) return [];
  const dependencies: { id: string; versionId: string }[] = [];
  for (const node of w.nodes) {
    if (!node || typeof node !== "object" || node.type !== "script" || !node.config || typeof node.config !== "object") continue;
    const { scriptId, scriptVersionId } = node.config;
    if (scriptId === undefined && scriptVersionId === undefined) continue;
    identity(scriptId); identity(scriptVersionId); dependencies.push({ id: scriptId, versionId: scriptVersionId });
  }
  return dependencies;
}
export function validatePortableBridge(value: unknown): asserts value is PortableBridge {
  const b = object(value, ["applications", "environments", "tools", "enabledTools"]);
  for (const k of Object.keys(b)) object(b[k]);
  const applications = object(b.applications), environments = object(b.environments);
  for (const [id, raw] of Object.entries(applications)) {
    const app = object(raw, ["id", "name", "enabled"]); check(app.id === id && /^[a-z][a-z0-9-]{0,49}$/.test(id), "INVALID_SNAPSHOT", "Invalid Bridge application identity"); string(app.name); bool(app.enabled);
  }
  const localEnvironments: Record<string, unknown[]> = Object.create(null);
  for (const [appId, raw] of Object.entries(environments)) {
    array(raw); localEnvironments[appId] = raw.map(v => {
      const env = object(v, ["id", "origin", "enabled"], ["profileId", "extensionId"]); identity(env.id); string(env.origin); bool(env.enabled);
      for (const k of ["profileId", "extensionId"]) if (Object.hasOwn(env, k)) ref(env[k], localReference("webBridge", appId, env.id, k));
      return { id: env.id, origin: env.origin, enabled: env.enabled, bound: false, tabAvailable: false };
    });
  }
  for (const raw of Object.values(object(b.tools))) object(raw, ["toolId", "application", "site", "description", "parameters", "path", "method", "fields", "risk", "approval", "timeoutMs", "catalogVersion", "enabled"]);
  validateBridgeConfigV1(canonicalSnapshotJson({ ...b, schemaVersion: 1, environments: localEnvironments }));
}
export function validatePortableSnapshot(value: unknown): asserts value is PortableSnapshot {
  // Reject accessors and non-JSON data before touching caller-owned fields.
  canonicalSnapshotJson(value);
  const s = object(value, ["general", "providers", "webBridge", "scripts", "workflows"]);
  const general = object(s.general, ["theme"]); check(["light", "dark", "system"].includes(String(general.theme)), "INVALID_SNAPSHOT", "Explicit theme is required");
  validatePortableBridge(s.webBridge);
  for (const k of ["providers", "scripts", "workflows"]) array(s[k]);
  const snapshot = value as PortableSnapshot;
  const allIds = new Set<string>(), versions = new Set<string>();
  const claim = (id: string) => { identity(id); check(!allIds.has(id), "DUPLICATE_ID", "Object identity is shared by multiple objects"); allIds.add(id); };
  for (const p of snapshot.providers) {
    object(p, ["id", "enabled", "config", "defaultModel", "models"]); claim(p.id);
    check(["pi-cli", "codex-cli"].includes(p.id), "PROVIDER_POLICY_MISSING", "Provider has no portable field policy");
    bool(p.enabled); string(p.defaultModel); object(p.config, ["executable", "transport"]); ref(p.config.executable, localReference("providers", p.id, "executable"));
    check(["legacy", "native"].includes(p.config.transport), "INVALID_SNAPSHOT", "Invalid transport"); array(p.models); unique(p.models, m => m.id);
    for (const m of p.models) { object(m, ["id", "name", "source", "enabled", "deleted"]); string(m.id); string(m.name); check(m.id.length > 0 && ["configured", "discovered"].includes(m.source), "INVALID_SNAPSHOT", "Invalid model"); bool(m.enabled); bool(m.deleted); }
    if (p.defaultModel) check(p.models.some(m => m.id === p.defaultModel && m.enabled && !m.deleted), "DEPENDENCY_MISSING", "Default model is missing or disabled");
  }
  for (const script of snapshot.scripts) {
    object(script, ["id", "name", "description", "runtime", "archived", "currentPublishedVersionId", "draft", "versions"]); claim(script.id); string(script.name); string(script.description); bool(script.archived); nullableId(script.currentPublishedVersionId);
    check(script.runtime === "nodejs" || script.runtime === "shell", "INVALID_SNAPSHOT", "Invalid runtime"); array(script.versions);
    for (const v of script.versions) {
      object(v, ["id", "definition"]); identity(v.id); check(!versions.has(v.id), "DUPLICATE_ID", "Duplicate version identity"); versions.add(v.id); validatePortableScript(v.definition, true);
      check(v.definition.id === script.id && v.definition.runtime === script.runtime, "INVALID_SNAPSHOT", "Script version ownership mismatch");
    }
    if (script.draft !== null) { validatePortableScript(script.draft, false); check(script.draft.id === script.id && script.draft.runtime === script.runtime, "INVALID_SNAPSHOT", "Script draft ownership mismatch"); }
    check(script.currentPublishedVersionId === null || script.versions.some(v => v.id === script.currentPublishedVersionId), "DEPENDENCY_MISSING", "Missing current script version");
  }
  for (const w of snapshot.workflows) {
    object(w, ["id", "name", "currentPublishedVersionId", "draft", "versions"]); claim(w.id); string(w.name); nullableId(w.currentPublishedVersionId); array(w.versions);
    const inspect = (files: SourceFiles, published: boolean) => {
      checkFiles(files); normalizedSource(files); check(workflowIdentity(files).id === w.id, "INVALID_SNAPSHOT", "Workflow identity mismatch");
      check(Object.hasOwn(files, "layout.json"), "INVALID_FILES", "Missing layout.json"); parseSnapshotJson(files["layout.json"]!);
      if (published) { validateWorkflow(parseSnapshotJson(files["workflow.json"]!)); readLayout(files); validateSourceSyntax(files); }
      const definition = object(parseSnapshotJson(files["workflow.json"]!));
      if (Array.isArray(definition.nodes)) for (const node of definition.nodes) {
        if (!node || typeof node !== "object" || !node.config || typeof node.config !== "object") continue;
        if (node.type === "code.nodejs" || node.type === "shell") {
          if (typeof node.config.script === "string") check(Object.hasOwn(files, node.config.script), "INVALID_FILES", "Missing workflow source script");
        }
        if (node.type === "agent") {
          const defaults = definition.defaults as { agent?: { providerId?: string; modelId?: string } } | undefined;
          const providerId = node.config.providerId ?? defaults?.agent?.providerId;
          const modelId = node.config.modelId ?? defaults?.agent?.modelId;
          if (providerId) {
            const provider = snapshot.providers.find(p => p.id === providerId);
            check(provider, "DEPENDENCY_MISSING", "Missing workflow Provider");
            if (modelId) check(provider.models.some(m => m.id === modelId && m.enabled && !m.deleted), "DEPENDENCY_MISSING", "Missing workflow model");
          }
        }
        if (node.type === "web-bridge" && node.config.application) {
          check(Object.hasOwn(snapshot.webBridge.applications, node.config.application), "DEPENDENCY_MISSING", "Missing workflow Bridge application");
          if (node.config.tool) check(Object.hasOwn(snapshot.webBridge.tools, `${node.config.application}/${node.config.tool}`), "DEPENDENCY_MISSING", "Missing workflow Bridge tool");
        }
      }
      for (const dep of workflowDependencies(files)) check(snapshot.scripts.some(s => s.id === dep.id && s.versions.some(v => v.id === dep.versionId)), "DEPENDENCY_MISSING", `Missing fixed script version for workflow ${w.id}`);
    };
    for (const v of w.versions) { object(v, ["id", "files"]); identity(v.id); check(!versions.has(v.id), "DUPLICATE_ID", "Duplicate version identity"); versions.add(v.id); inspect(v.files, true); }
    if (w.draft !== null) { object(w.draft, ["files", "baseVersionId"]); nullableId(w.draft.baseVersionId); inspect(w.draft.files, false); check(w.draft.baseVersionId === null || w.versions.some(v => v.id === w.draft!.baseVersionId), "DEPENDENCY_MISSING", "Missing workflow draft baseline"); }
    check(w.currentPublishedVersionId === null || w.versions.some(v => v.id === w.currentPublishedVersionId), "DEPENDENCY_MISSING", "Missing current workflow version");
  }
}
export function fixedDependencies(snapshot: PortableSnapshot, files: SourceFiles[]): SnapshotDependency[] {
  const deps = new Map<string, SnapshotDependency>();
  for (const source of files) for (const dep of workflowDependencies(source)) {
    const version = snapshot.scripts.find(s => s.id === dep.id)!.versions.find(v => v.id === dep.versionId)!;
    deps.set(dep.versionId, { category: "scripts", ...dep, digest: portableScriptHash(dep.versionId, version.definition) });
  }
  return [...deps.values()].sort((a, b) => compareCodePoints(a.id, b.id) || compareCodePoints(a.versionId, b.versionId));
}
