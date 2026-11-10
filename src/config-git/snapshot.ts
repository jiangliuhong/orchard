import { exportDictionaries, dictionaryDependencies } from "./dictionaries.js";
import { readFileSync } from "node:fs";
import type { Store } from "../persistence/store.js";
import type { WebBridgeConfig } from "../web-bridge/config.js";
import type { ScriptDefinition } from "../domain/scripts.js";
import type { SourceFiles } from "../domain/types.js";
import { check } from "../domain/errors.js";
import type { PortableSnapshot, PortableWorkflow, PortableScript, PortableBridge, SnapshotBundle, SnapshotManifest, SnapshotObject, SnapshotTheme } from "./snapshot-types.js";
import { array, canonicalSnapshotJson, compareCodePoints, declarativeConfig, encodeSnapshotId, localReference, normalizeSnapshotText, object, parseDeclarativeConfig, parseSnapshotJson, snapshotDigest, snapshotPath, string } from "./snapshot-primitives.js";
import { fixedDependencies, normalizedScript, normalizedSource, portableScriptHash, portableWorkflowHash, validatePortableSnapshot, workflowDependencies, workflowIdentity } from "./snapshot-validation.js";
export * from "./snapshot-types.js";
export { canonicalSnapshotJson, parseDeclarativeConfig, snapshotDigest, encodeSnapshotId, localReference } from "./snapshot-primitives.js";
export { portableScriptHash, portableWorkflowHash, validatePortableSnapshot } from "./snapshot-validation.js";

const CATEGORIES = ["general", "providers", "webBridge", "scripts", "workflows"] as const;
const sorted = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => compareCodePoints(a.id, b.id));
const workflowRoot = (id: string) => `workflows/${encodeSnapshotId(id)}`;
const scriptRoot = (id: string) => `scripts/${encodeSnapshotId(id)}`;
const versionPath = (root: string, id: string) => `${root}/versions/${encodeSnapshotId(id)}`;

function normalizedSnapshot(value: PortableSnapshot): PortableSnapshot {
  validatePortableSnapshot(value);
  return {
    ...(value.dictionaries !== undefined ? { dictionaries: sorted(value.dictionaries).map(d => ({ ...d, versions: sorted(d.versions) })) } : {}),
    general: { ...value.general },
    providers: sorted(value.providers).map(p => ({ ...p, models: sorted(p.models), ...(p.agentModelConfigs ? { agentModelConfigs: sorted(p.agentModelConfigs) } : {}) })),
    webBridge: { ...value.webBridge, environments: Object.fromEntries(Object.entries(value.webBridge.environments).map(([id, envs]) => [id, sorted(envs)])) },
    scripts: sorted(value.scripts).map(s => ({ ...s, draft: s.draft ? normalizedScript(s.draft) : null, versions: sorted(s.versions).map(v => ({ id: v.id, definition: normalizedScript(v.definition) })) })),
    workflows: sorted(value.workflows).map(w => ({ ...w, draft: w.draft ? { ...w.draft, files: normalizedSource(w.draft.files) } : null, versions: sorted(w.versions).map(v => ({ id: v.id, files: normalizedSource(v.files) })) })),
  };
}
function manifestFor(snapshot: PortableSnapshot, files: SourceFiles): SnapshotManifest {
  const objects: SnapshotObject[] = [];
  const add = (category: SnapshotObject["category"], id: string, path: string, value: unknown, versions: SnapshotObject["versions"] = [], dependencies: SnapshotObject["dependencies"] = []) => {
    objects.push({ category, id, path, digest: snapshotDigest(canonicalSnapshotJson(value)), versions, dependencies });
  };
  add("general", "general", "settings/general.config.ts", snapshot.general);
  add("webBridge", "webBridge", "settings/web-bridge.config.ts", snapshot.webBridge);
  for (const p of snapshot.providers) add("providers", p.id, `settings/providers/${encodeSnapshotId(p.id)}.config.ts`, p);
  for (const d of snapshot.dictionaries ?? []) add("dictionaries", d.id, `dictionaries/${encodeSnapshotId(d.id)}/dictionary.json`, d, d.versions.map(v => ({ id: v.id, digest: snapshotDigest(canonicalSnapshotJson(v)) })));
  for (const s of snapshot.scripts) add("scripts", s.id, `${scriptRoot(s.id)}/script.config.ts`, s, s.versions.map(v => ({ id: v.id, digest: portableScriptHash(v.id, v.definition) })), dictionaryDependencies(snapshot, s));
  for (const w of snapshot.workflows) add("workflows", w.id, `${workflowRoot(w.id)}/workflow.config.ts`, w, w.versions.map(v => ({ id: v.id, digest: portableWorkflowHash(w.id, v.id, v.files) })), [...fixedDependencies(snapshot, [...w.versions.map(v => v.files), ...(w.draft ? [w.draft.files] : [])]), ...dictionaryDependencies(snapshot, w)]);
  objects.sort((a, b) => compareCodePoints(a.category, b.category) || compareCodePoints(a.id, b.id));
  return { formatVersion: snapshot.dictionaries === undefined ? 1 : 2, minOrchardVersion: "0.1.0", categories: [...CATEGORIES, ...(snapshot.dictionaries === undefined ? [] : ["dictionaries" as const])], objects, files: Object.keys(files).filter(p => p !== "manifest.json").sort(compareCodePoints).map(path => ({ path, bytes: Buffer.byteLength(files[path]!, "utf8"), sha256: snapshotDigest(files[path]!) })) };
}
function finish(snapshot: PortableSnapshot, files: SourceFiles): SnapshotBundle {
  const manifest = manifestFor(snapshot, files);
  const text = canonicalSnapshotJson(manifest) + "\n";
  const complete = Object.fromEntries(Object.entries({ ...files, "manifest.json": text }).sort(([a], [b]) => compareCodePoints(a, b)));
  checkFileSet(complete);
  return { snapshot, files: complete, manifest, digest: snapshotDigest(text) };
}
/** Pure, deterministic data-to-file conversion. No filesystem or database writes. */
export function serializeSnapshot(value: PortableSnapshot): SnapshotBundle {
  const snapshot = normalizedSnapshot(value), files: SourceFiles = Object.create(null);
  files["settings/general.config.ts"] = declarativeConfig(snapshot.general);
  files["settings/web-bridge.config.ts"] = declarativeConfig(snapshot.webBridge);
  for (const d of snapshot.dictionaries ?? []) {
    const root = `dictionaries/${encodeSnapshotId(d.id)}`;
    files[`${root}/dictionary.json`] = canonicalSnapshotJson({ id: d.id, kind: d.kind, currentVersionId: d.currentVersionId }) + "\n";
    for (const v of d.versions) files[`${root}/versions/${encodeSnapshotId(v.id)}.json`] = canonicalSnapshotJson(v) + "\n";
  }
  for (const p of snapshot.providers) files[`settings/providers/${encodeSnapshotId(p.id)}.config.ts`] = declarativeConfig(p);
  const writeSources = (root: string, sources: SourceFiles) => { for (const [path, text] of Object.entries(sources)) files[`${root}/${snapshotPath(path)}`] = text; };
  const writeScript = (root: string, definition: ScriptDefinition, versionId: string | null) => {
    const { files: sources, ...metadata } = definition;
    check(!Object.hasOwn(sources, "definition.config.ts"), "INVALID_PATH", "Script source collides with definition descriptor");
    files[`${root}/definition.config.ts`] = declarativeConfig({ ...metadata, versionId, sourceFiles: Object.keys(sources).sort(compareCodePoints) }); writeSources(root, sources);
  };
  for (const s of snapshot.scripts) {
    const root = scriptRoot(s.id), draft = s.draft ? { path: `${root}/draft` } : null;
    files[`${root}/script.config.ts`] = declarativeConfig({ id: s.id, name: s.name, description: s.description, runtime: s.runtime, archived: s.archived, currentPublishedVersionId: s.currentPublishedVersionId, draft, versions: s.versions.map(v => ({ id: v.id, path: versionPath(root, v.id) })) });
    if (s.draft) writeScript(draft!.path, s.draft, null);
    for (const v of s.versions) writeScript(versionPath(root, v.id), v.definition, v.id);
  }
  for (const w of snapshot.workflows) {
    const root = workflowRoot(w.id), draft = w.draft ? { path: `${root}/draft`, baseVersionId: w.draft.baseVersionId } : null;
    files[`${root}/workflow.config.ts`] = declarativeConfig({ id: w.id, name: w.name, currentPublishedVersionId: w.currentPublishedVersionId, draft, versions: w.versions.map(v => ({ id: v.id, path: versionPath(root, v.id) })) });
    if (w.draft) writeSources(draft!.path, w.draft.files);
    for (const v of w.versions) writeSources(versionPath(root, v.id), v.files);
  }
  return finish(snapshot, files);
}
function checkFileSet(files: SourceFiles) {
  object(files); const entries = Object.entries(files); let total = 0;
  check(entries.length <= 10000, "SNAPSHOT_LIMIT", "Snapshot exceeds 10000 files");
  for (const [path, text] of entries) {
    snapshotPath(path); check(typeof text === "string", "INVALID_SNAPSHOT", "Snapshot files must be UTF-8 strings");
    check(normalizeSnapshotText(text) === text, "INVALID_SNAPSHOT", "Snapshot files must use LF newlines");
    const size = Buffer.byteLength(text); check(size <= 4 * 1024 * 1024, "SNAPSHOT_LIMIT", "Snapshot file exceeds 4 MiB"); total += size;
  }
  check(total <= 64 * 1024 * 1024, "SNAPSHOT_LIMIT", "Snapshot exceeds 64 MiB");
}
function decode(files: SourceFiles, v2 = false): PortableSnapshot {
  checkFileSet(files);
  const used = new Set<string>(["manifest.json"]);
  const config = (path: string) => {
    check(Object.hasOwn(files, path), "INVALID_FILES", `Missing configuration file: ${path}`); used.add(path); return parseDeclarativeConfig(files[path]!);
  };
  const readSources = (root: string, names?: string[]): SourceFiles => {
    snapshotPath(root);
    const paths = names ?? Object.keys(files).filter(p => p.startsWith(`${root}/`)).map(p => p.slice(root.length + 1));
    check(new Set(paths).size === paths.length, "DUPLICATE_ID", "Duplicate source path");
    return Object.fromEntries(paths.map(name => {
      snapshotPath(name); const path = `${root}/${name}`;
      check(Object.hasOwn(files, path) && !used.has(path), "INVALID_FILES", "Missing or multiply referenced source file"); used.add(path); return [name, files[path]!];
    }));
  };
  const snapshot: PortableSnapshot = { general: config("settings/general.config.ts") as PortableSnapshot["general"], providers: [], webBridge: config("settings/web-bridge.config.ts") as PortableBridge, scripts: [], workflows: [] };
  if (v2) {
    snapshot.dictionaries = [];
    for (const path of Object.keys(files).filter(p => /^dictionaries\/[^/]+\/dictionary.json$/.test(p))) {
      used.add(path); const d = object(parseSnapshotJson(files[path]!), ["id", "kind", "currentVersionId"]); string(d.id);
      const root = `dictionaries/${encodeSnapshotId(d.id)}`; check(path === `${root}/dictionary.json`, "INVALID_ID", "Dictionary path identity mismatch");
      const versions = Object.keys(files).filter(p => p.startsWith(`${root}/versions/`)).map(p => { used.add(p); const v = object(parseSnapshotJson(files[p]!)); string(v.id); check(p === `${root}/versions/${encodeSnapshotId(v.id)}.json`, "INVALID_ID", "Dictionary version path identity mismatch"); return v; });
      snapshot.dictionaries.push({ ...d, versions } as unknown as NonNullable<PortableSnapshot["dictionaries"]>[number]);
    }
  }
  for (const path of Object.keys(files).sort(compareCodePoints)) {
    if (/^settings\/providers\/[^/]+\.config\.ts$/.test(path)) {
      const p = object(config(path)); string(p.id); check(path === `settings/providers/${encodeSnapshotId(p.id)}.config.ts`, "INVALID_ID", "Provider path identity mismatch"); snapshot.providers.push(p as unknown as PortableSnapshot["providers"][number]);
    } else if (/^scripts\/[^/]+\/script\.config\.ts$/.test(path)) {
      const s = object(config(path), ["id", "name", "description", "runtime", "archived", "currentPublishedVersionId", "draft", "versions"]); string(s.id);
      const root = scriptRoot(s.id); check(path === `${root}/script.config.ts`, "INVALID_ID", "Script path identity mismatch"); array(s.versions);
      const definition = (at: string, versionId: string | null): ScriptDefinition => {
        const d = object(config(`${at}/definition.config.ts`), ["id", "versionId", "name", "description", "runtime", "entryFile", "inputSchema", "outputSchema", "timeoutMs", "resultMode", "sourceFiles"], v2 ? ["dictionaryBindings"] : []);
        check(d.id === s.id && d.versionId === versionId, "INVALID_ID", "Script definition identity mismatch"); array(d.sourceFiles); d.sourceFiles.forEach(string);
        const { sourceFiles, versionId: ignored, ...metadata } = d;
        return { ...metadata, files: readSources(at, sourceFiles as string[]) } as unknown as ScriptDefinition;
      };
      let draft: ScriptDefinition | null = null;
      if (s.draft !== null) { const d = object(s.draft, ["path"]); check(d.path === `${root}/draft`, "INVALID_PATH", "Invalid script draft path"); draft = definition(d.path as string, null); }
      const versions = s.versions.map(raw => { const v = object(raw, ["id", "path"]); string(v.id); const at = versionPath(root, v.id); check(v.path === at, "INVALID_PATH", "Invalid script version path"); return { id: v.id, definition: definition(at, v.id) }; });
      snapshot.scripts.push({ ...s, draft, versions } as unknown as PortableScript);
    } else if (/^workflows\/[^/]+\/workflow\.config\.ts$/.test(path)) {
      const w = object(config(path), ["id", "name", "currentPublishedVersionId", "draft", "versions"]); string(w.id);
      const root = workflowRoot(w.id); check(path === `${root}/workflow.config.ts`, "INVALID_ID", "Workflow path identity mismatch"); array(w.versions);
      let draft: PortableWorkflow["draft"] = null;
      if (w.draft !== null) { const d = object(w.draft, ["path", "baseVersionId"]); check(d.path === `${root}/draft`, "INVALID_PATH", "Invalid workflow draft path"); draft = { baseVersionId: d.baseVersionId as string | null, files: readSources(d.path as string) }; }
      const versions = w.versions.map(raw => { const v = object(raw, ["id", "path"]); string(v.id); const at = versionPath(root, v.id); check(v.path === at, "INVALID_PATH", "Invalid workflow version path"); return { id: v.id, files: readSources(at) }; });
      snapshot.workflows.push({ ...w, draft, versions } as unknown as PortableWorkflow);
    }
  }
  check(Object.keys(files).every(p => used.has(p)), "INVALID_FILES", "Unindexed or unrecognized snapshot file");
  return normalizedSnapshot(snapshot);
}
function validateManifestHeader(value: unknown): SnapshotManifest {
  const m = object(value, ["formatVersion", "minOrchardVersion", "categories", "objects", "files"]);
  check(m.formatVersion === 1 || m.formatVersion === 2, "FORMAT_UNSUPPORTED", "Unsupported configuration snapshot version");
  check(typeof m.minOrchardVersion === "string" && /^\d+\.\d+\.\d+$/.test(m.minOrchardVersion), "FORMAT_UNSUPPORTED", "Invalid minimum Orchard version");
  const parts = m.minOrchardVersion.split(".").map(Number); check(parts[0] === 0 && parts[1] === 1 && parts[2] === 0 || parts[0] === 0 && parts[1] === 0, "FORMAT_UNSUPPORTED", "Snapshot requires a newer Orchard version");
  array(m.categories); check(canonicalSnapshotJson([...m.categories].sort()) === canonicalSnapshotJson([...CATEGORIES, ...(m.formatVersion === 2 ? ["dictionaries"] : [])].sort()), "INVALID_SNAPSHOT", "All snapshot categories must be declared exactly once"); array(m.objects); array(m.files);
  return m as unknown as SnapshotManifest;
}
/** Validates the complete tree and all authoritative digests before returning restore DTOs. */
export function parseSnapshot(files: SourceFiles): PortableSnapshot {
  checkFileSet(files); check(Object.hasOwn(files, "manifest.json"), "INVALID_FILES", "Missing manifest.json");
  const manifest = validateManifestHeader(parseSnapshotJson(files["manifest.json"]!));
  const snapshot = decode(files, manifest.formatVersion === 2), expected = manifestFor(snapshot, files);
  check(canonicalSnapshotJson(manifest.files) === canonicalSnapshotJson(expected.files), "DIGEST_MISMATCH", "Manifest file set, size or digest mismatch");
  check(canonicalSnapshotJson(manifest.objects) === canonicalSnapshotJson(expected.objects), "DIGEST_MISMATCH", "Manifest object identity, dependency or definition digest mismatch");
  return snapshot;
}
/** Refresh only manifest bytes; all declarations, source paths and dependencies remain validated. */
export function refreshManifest(files: SourceFiles): SnapshotBundle {
  checkFileSet(files);
  const header = Object.hasOwn(files, "manifest.json") ? validateManifestHeader(parseSnapshotJson(files["manifest.json"]!)) : undefined;
  return finish(decode(files, header?.formatVersion === 2), files);
}

/** Caller holds the configuration read window while this synchronous copy runs. */
export function exportSnapshot(store: Store, bridge: WebBridgeConfig | Record<string, unknown>, theme: SnapshotTheme): SnapshotBundle {
  check(["light", "dark", "system"].includes(theme), "GENERAL_REQUIRED", "Export requires an explicit theme");
  const raw = typeof bridge.applications === "function" ? JSON.parse(readFileSync(store.files.path("config/web-bridge.json"), "utf8")) as Record<string, unknown> : bridge;
  const b = object(raw), applications = object(b.applications), environments = object(b.environments);
  const portableBridge: PortableBridge = {
    applications: Object.fromEntries(Object.entries(applications).map(([id, raw]) => { const app = object(raw); return [id, { id: app.id, name: app.name, enabled: app.enabled }]; })) as PortableBridge["applications"],
    environments: Object.fromEntries(Object.entries(environments).map(([appId, raw]) => {
      array(raw); return [appId, raw.map(v => { const e = object(v); string(e.id); return { id: e.id, origin: e.origin, enabled: e.enabled,
        ...(e.profileId ? { profileId: localReference("webBridge", appId, e.id, "profileId") } : {}), ...(e.extensionId ? { extensionId: localReference("webBridge", appId, e.id, "extensionId") } : {}) }; })];
    })) as PortableBridge["environments"], tools: b.tools as PortableBridge["tools"], enabledTools: b.enabledTools as PortableBridge["enabledTools"],
  };
  const providers = store.all<{ id: string }>("SELECT id FROM provider_settings ORDER BY id").map(row => {
    const p = store.provider(row.id)!;
    check(["pi-cli", "codex-cli"].includes(p.id), "PROVIDER_POLICY_MISSING", "Provider has no portable field policy");
    for (const key of Object.keys(p.config)) check(["executable", "transport"].includes(key), "PROVIDER_POLICY_MISSING", `Unclassified Provider configuration field: ${key}`);
    return { id: p.id, enabled: p.enabled, config: { executable: localReference("providers", p.id, "executable"), transport: "native" as const }, defaultModel: p.defaultModel,
      models: p.models.map(m => ({ id: m.id, name: m.name, source: m.source, enabled: m.enabled ?? true, deleted: m.deleted ?? false })),
      agentModelConfigs: store.all<{ id: string; name: string; description: string; modelId: string; enabled: number }>("SELECT id,name,description,model_id AS modelId,enabled FROM agent_model_configs WHERE provider_id=? ORDER BY id", p.id).map(config => ({ ...config, enabled: !!config.enabled })) };
  });
  const workflows = new Map<string, PortableWorkflow>();
  const workflowFiles = (path: string) => ({ "layout.json": "{}\n", ...store.files.readTree(path).files });
  const workflowVersion = (workflowId: string, id: string) => { const v = store.version(id); check(v.workflowId === workflowId, "INVALID_ID", "Workflow version ownership mismatch"); return { id, files: workflowFiles(v.artifactPath) }; };
  for (const w of store.workflows()) workflows.set(w.id, { id: w.id, name: w.name, currentPublishedVersionId: w.currentVersionId ?? null, draft: null, versions: w.currentVersionId ? [workflowVersion(w.id, w.currentVersionId)] : [] });
  for (const d of store.drafts().filter(d => d.status !== "published")) {
    const files = workflowFiles(d.artifactPath), { id, name } = workflowIdentity(files);
    check(d.workflowId === null || d.workflowId === id, "INVALID_ID", `Workflow draft identity mismatch: ${d.id}`);
    const w = workflows.get(id) ?? { id, name, currentPublishedVersionId: null, draft: null, versions: [] };
    check(w.draft === null, "DUPLICATE_ID", `Multiple drafts declare workflow ${id}`);
    w.draft = { files, baseVersionId: d.baseVersionId };
    if (d.baseVersionId && !w.versions.some(v => v.id === d.baseVersionId)) w.versions.push(workflowVersion(id, d.baseVersionId));
    workflows.set(id, w);
  }
  const required = new Map<string, Set<string>>();
  for (const w of workflows.values()) for (const files of [...w.versions.map(v => v.files), ...(w.draft ? [w.draft.files] : [])]) for (const dep of workflowDependencies(files)) {
    if (!required.has(dep.id)) required.set(dep.id, new Set()); required.get(dep.id)!.add(dep.versionId);
  }
  const scripts: PortableScript[] = store.scripts().map(s => {
    const ids = required.get(s.id) ?? new Set<string>(); if (s.currentPublishedVersionId) ids.add(s.currentPublishedVersionId);
    const read = (id: string, published: boolean): ScriptDefinition => {
      const v = store.scriptVersion(id); check(v.scriptId === s.id && v.status === (published ? "published" : "draft"), "DEPENDENCY_MISSING", "Script version ownership or status mismatch");
      const tree = store.files.readScriptTree(v.sourceRef);
      return { id: s.id, name: tree.definition?.name ?? s.name, description: tree.definition?.description ?? s.description, runtime: s.runtime, entryFile: v.entryFile, timeoutMs: v.timeoutMs, inputSchema: v.inputSchema, outputSchema: v.outputSchema, resultMode: tree.definition?.resultMode ?? (s.runtime === "shell" ? "process" : "json"), ...(tree.definition?.dictionaryBindings ? { dictionaryBindings: tree.definition.dictionaryBindings } : {}), files: tree.files };
    };
    return { id: s.id, name: s.name, description: s.description, runtime: s.runtime, archived: s.status === "archived", currentPublishedVersionId: s.currentPublishedVersionId, draft: s.currentDraftVersionId ? read(s.currentDraftVersionId, false) : null, versions: [...ids].map(id => ({ id, definition: read(id, true) })) };
  });
  return serializeSnapshot({ dictionaries: exportDictionaries(store), general: { theme }, providers, webBridge: portableBridge, scripts, workflows: [...workflows.values()] });
}
export class ConfigSnapshotService {
  export = exportSnapshot;
  serialize = serializeSnapshot;
  parse = parseSnapshot;
  refreshManifest = refreshManifest;
}
