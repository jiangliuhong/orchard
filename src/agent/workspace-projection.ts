import { AppError, check } from "../domain/errors.js";
import { canonicalJson, digest, safeFile } from "../persistence/files.js";
import { assertQuerySafe, type AssetSnapshot } from "./query-gateway.js";

export interface ProjectionResource {
  state: "draft" | "published" | "historical";
  snapshot: AssetSnapshot;
  draftId?: string;
}
export interface ProjectionApplication {
  id: string; revision: string;
  /** Public configuration only, never the raw browser runtime/config object. */
  definition: unknown;
  tools: readonly AssetSnapshot[];
}
export interface WorkspaceProjection {
  hash: string; bytes: number;
  /** Business files only. The installer composes package-owned rules separately. */
  files: Readonly<Record<string, string>>;
}
export const PROJECTION_LIMITS = Object.freeze({ resources: 2000, files: 10000, fileBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024 });
export interface WorkflowDependency { kind: "script" | "bridge_tool"; id: string; version?: string }
export function projectionSegment(value: string): string {
  check(typeof value === "string" && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(value), "PROJECTION_INVALID_PATH", "投影资源标识不是安全路径段");
  return value;
}
function sourcePath(value: string): string {
  check(typeof value === "string" && value.length <= 240 && value.split("/").every(part => projectionSegment(part) === part), "PROJECTION_INVALID_PATH", "投影源码路径无效");
  return value;
}
const jsonText = (value: unknown) => `${canonicalJson(value)}\n`;
const key = (kind: string, id: string, version?: string) => canonicalJson([kind, id, version ?? null]);

export function assertScriptProjectionSafe(definition: unknown, files: Readonly<Record<string, string>>, knownSecrets: readonly string[]) {
  assertQuerySafe(jsonText(definition), knownSecrets);
  for (const content of Object.values(files)) assertQuerySafe(content, knownSecrets);
}

function sensitiveContentWithheld(checkContent: () => void): true | undefined {
  try { checkContent(); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== "QUERY_SENSITIVE_CONTENT") throw error;
    return true;
  }
}

function safeWithheldMetadata(snapshot: AssetSnapshot, knownSecrets: readonly string[]) {
  const definition = snapshot.definition as Record<string, unknown>;
  const fields = snapshot.kind === "script" && snapshot.id === "fm-rex-outbound-api"
    ? ["runtime", "resultMode", "outputSchema"]
    : snapshot.kind === "bridge_tool" && snapshot.id === "fm-rex/outbound_request"
      ? ["method", "fields"]
      : [];
  if (!fields.length) return {};
  const safeMetadata = Object.fromEntries(fields.filter(field => Object.hasOwn(definition, field)).map(field => [field, definition[field]]));
  return sensitiveContentWithheld(() => assertQuerySafe(jsonText(safeMetadata), knownSecrets)) ? {} : { safeMetadata };
}

const valueKeywords = new Set(["default", "const", "enum", "example", "examples"]);
const namedSchemas = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);

function assertCredentialSchemaSafe(schema: unknown, depth = 0): void {
  check(depth < 64, "PROJECTION_INVALID_SOURCE", "凭据 Schema 嵌套超限");
  if (Array.isArray(schema)) {
    for (const item of schema) assertCredentialSchemaSafe(item, depth + 1);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  for (const [keyword, value] of Object.entries(schema)) {
    check(!valueKeywords.has(keyword), "QUERY_SENSITIVE_CONTENT", "凭据 Schema 不可包含字面凭据值", 403);
    if (namedSchemas.has(keyword) && value && typeof value === "object") {
      for (const child of Object.values(value)) assertCredentialSchemaSafe(child, depth + 1);
    } else {
      assertCredentialSchemaSafe(value, depth + 1);
    }
  }
}

export function assertProjectedToolSafe(definition: unknown): void {
  const execution = (definition as { execution?: { transport?: string; credentialSchema?: unknown } } | null)?.execution;
  if (execution?.transport === "browser") assertCredentialSchemaSafe(execution.credentialSchema);
}

/** Extract only structured platform references. Invalid drafts remain readable,
 * but must never be described as having a complete dependency graph. */
export function workflowProjectionDependencies(text: string): { complete: boolean; items: WorkflowDependency[] } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { complete: false, items: [] }; }
  const nodes = value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodes)) return { complete: false, items: [] };
  const items: WorkflowDependency[] = []; let complete = true;
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object" || typeof raw.type !== "string") { complete = false; continue; }
    if (raw.type !== "script" && raw.type !== "web-bridge") continue;
    const config = raw.config;
    if (!config || typeof config !== "object") { complete = false; continue; }
    if (raw.type === "script") {
      if (typeof config.scriptId !== "string" || !config.scriptId || typeof config.scriptVersionId !== "string" || !config.scriptVersionId) { complete = false; continue; }
      items.push({ kind: "script", id: config.scriptId, version: config.scriptVersionId });
    } else {
      if (typeof config.application !== "string" || !config.application || typeof config.tool !== "string" || !config.tool) { complete = false; continue; }
      items.push({ kind: "bridge_tool", id: `${config.application}/${config.tool}` });
    }
  }
  return { complete, items: [...new Map(items.map(item => [key(item.kind, item.id, item.version), item])).values()] };
}

/** Pure compiler. The caller authorizes a consistent complete business snapshot.
 * Output identity is not a durable sync receipt or a write authorization. */
export function buildWorkspaceProjection(input: {
  resources: readonly ProjectionResource[]; applications: readonly ProjectionApplication[]; knownSecrets: readonly string[];
}): WorkspaceProjection {
  check(input.resources.length + input.applications.length + input.applications.reduce((n, app) => n + app.tools.length, 0) <= PROJECTION_LIMITS.resources,
    "PROJECTION_TOO_LARGE", "投影资源数量超限");
  const files = new Map<string, string>(), occupiedFiles = new Set<string>(), occupiedDirectories = new Set<string>();
  const identities = new Map<string, { hash: string; path: string; contentWithheld?: true }>();
  const workflowGroups = new Map<string, { draftId: string; path: string; version: string }[]>();
  const publishedWorkflows = new Map<string, string>();
  const entries: { kind: string; id: string; version: string | null; revision: string; state: string; path: string; dependenciesComplete: boolean; contentWithheld?: true }[] = [];
  const dependencies: { source: string; target: WorkflowDependency }[] = [];
  let bytes = 0;
  const add = (path: string, content: string) => {
    const folded = path.toLowerCase();
    const parents = folded.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
    check(!occupiedFiles.has(folded) && !occupiedDirectories.has(folded) && parents.every(parent => !occupiedFiles.has(parent)), "PROJECTION_COLLISION", "投影路径重复或文件与目录冲突");
    check(typeof content === "string", "PROJECTION_INVALID_SOURCE", "投影源码必须是文本");
    const size = Buffer.byteLength(content);
    check(files.size < PROJECTION_LIMITS.files && size <= PROJECTION_LIMITS.fileBytes && bytes + size <= PROJECTION_LIMITS.totalBytes, "PROJECTION_TOO_LARGE", "投影文件或总字节数超限");
    assertQuerySafe(content, input.knownSecrets);
    files.set(path, content); occupiedFiles.add(folded); parents.forEach(parent => occupiedDirectories.add(parent)); bytes += size;
  };
  const metadata = (snapshot: AssetSnapshot, state: string, extra = {}) => {
    check(typeof snapshot.revision === "string" && snapshot.revision.length > 0, "PROJECTION_INVALID_RESOURCE", "投影资源缺少 revision");
    return { id: snapshot.id, kind: snapshot.kind, version: snapshot.version ?? null, revision: snapshot.revision, state, readOnly: true,
      ...(snapshot.validation ? { valid: snapshot.validation.valid } : {}), ...extra };
  };
  // Current versions win dependency lookup, independent of enumeration order.
  const resources = [...input.resources].sort((a, b) => Number(a.state === "historical") - Number(b.state === "historical"));
  for (const { state, snapshot, draftId: explicitDraft } of resources) {
    check(["draft", "published", "historical"].includes(state) && ["workflow", "script"].includes(snapshot.kind), "PROJECTION_INVALID_RESOURCE", "投影资源类型或状态无效");
    check(typeof snapshot.version === "string" && snapshot.version.length > 0, "PROJECTION_INVALID_RESOURCE", "投影资源缺少准确版本");
    check(state !== "historical" || snapshot.kind === "script", "PROJECTION_INVALID_RESOURCE", "历史投影仅支持固定脚本依赖");
    const draftId = snapshot.kind === "workflow" && state === "draft" ? projectionSegment(explicitDraft ?? (snapshot.version.startsWith("draft:") ? snapshot.version.slice(6) : "")) : undefined;
    const location = draftId ? `drafts/${draftId}` : state === "historical" ? `versions/${projectionSegment(snapshot.version)}` : state;
    const base = `${snapshot.kind === "workflow" ? "workflows" : "scripts"}/${projectionSegment(snapshot.id)}/${location}`;
    const identity = key(snapshot.kind, snapshot.id, snapshot.version);
    const contentHash = digest(canonicalJson({ definition: snapshot.definition, files: snapshot.files, revision: snapshot.revision }));
    const prior = identities.get(identity);
    check(!prior || prior.hash === contentHash, "PROJECTION_VERSION_MISMATCH", "同一版本的投影内容不一致");
    if (state === "historical" && prior) continue;
    if (!prior) identities.set(identity, { hash: contentHash, path: base });
    let complete = true;
    let contentWithheld: true | undefined;
    if (snapshot.kind === "script") {
      const sources = Object.entries(snapshot.files).map(([path, content]) => [sourcePath(path), content] as const);
      contentWithheld = sensitiveContentWithheld(() => assertScriptProjectionSafe(snapshot.definition, snapshot.files, input.knownSecrets));
      if (contentWithheld && !prior) identities.set(identity, { hash: contentHash, path: base, contentWithheld });
      if (!contentWithheld) {
        add(`${base}/script.json`, jsonText(snapshot.definition));
        for (const [path, content] of sources) add(`${base}/src/${path}`, content);
      }
    } else {
      check(Object.hasOwn(snapshot.files, "workflow.json"), "PROJECTION_INVALID_SOURCE", "工作流投影缺少 workflow.json");
      for (const [path, content] of Object.entries(snapshot.files)) { safeFile(path); if (path !== "layout.json") add(`${base}/${path}`, content); }
      const parsed = workflowProjectionDependencies(snapshot.files["workflow.json"]!); complete = parsed.complete;
      check(complete || state === "draft", "PROJECTION_DEPENDENCY_UNKNOWN", "发布工作流无法确认完整依赖");
      for (const target of parsed.items) dependencies.push({ source: base, target });
      const group = workflowGroups.get(snapshot.id) ?? []; workflowGroups.set(snapshot.id, group);
      if (draftId) group.push({ draftId, path: base, version: snapshot.version });
      else publishedWorkflows.set(snapshot.id, snapshot.version);
    }
    const visibility = contentWithheld ? { contentWithheld, reason: "QUERY_SENSITIVE_CONTENT" } : {};
    add(`${base}/resource.json`, jsonText(metadata(snapshot, state, { dependenciesComplete: complete, ...visibility, ...(contentWithheld ? safeWithheldMetadata(snapshot, input.knownSecrets) : {}), ...(!complete ? { valid: false } : {}), ...(draftId ? { draftId } : {}) })));
    entries.push({ kind: snapshot.kind, id: snapshot.id, version: snapshot.version, revision: snapshot.revision, state, path: base, dependenciesComplete: complete, ...visibility });
  }
  for (const [id, drafts] of workflowGroups) add(`workflows/${projectionSegment(id)}/resource.json`, jsonText({ id, kind: "workflow", readOnly: true,
    drafts: drafts.sort((a, b) => a.draftId.localeCompare(b.draftId)), publishedVersion: publishedWorkflows.get(id) ?? null }));
  for (const application of input.applications) {
    const base = `browser-tools/${projectionSegment(application.id)}`;
    check(typeof application.revision === "string" && application.revision.length > 0, "PROJECTION_INVALID_RESOURCE", "浏览器应用缺少 revision");
    add(`${base}/resource.json`, jsonText({ id: application.id, kind: "bridge_application", revision: application.revision, readOnly: true, definition: application.definition }));
    entries.push({ kind: "bridge_application", id: application.id, version: null, revision: application.revision, state: "configured", path: base, dependenciesComplete: true });
    for (const tool of application.tools) {
      check(tool.kind === "bridge_tool" && tool.id.startsWith(`${application.id}/`) && Object.keys(tool.files).length === 0, "PROJECTION_INVALID_RESOURCE", "浏览器工具归属无效或携带额外源码");
      const path = `${base}/${projectionSegment(tool.id.slice(application.id.length + 1))}`;
      const definition = jsonText(tool.definition);
      const contentWithheld = sensitiveContentWithheld(() => {
        assertProjectedToolSafe(tool.definition);
        assertQuerySafe(definition, input.knownSecrets);
      });
      const visibility = contentWithheld ? { contentWithheld, reason: "QUERY_SENSITIVE_CONTENT" } : {};
      add(`${path}/resource.json`, jsonText(metadata(tool, "configured", { ...visibility, ...(contentWithheld ? safeWithheldMetadata(tool, input.knownSecrets) : {}) })));
      if (!contentWithheld) add(`${path}/tool.json`, definition);
      identities.set(key("bridge_tool", tool.id), { hash: tool.revision, path, contentWithheld });
      entries.push({ kind: tool.kind, id: tool.id, version: tool.version ?? null, revision: tool.revision, state: "configured", path, dependenciesComplete: true, ...visibility });
    }
  }
  const resolved = dependencies.map(({ source, target }) => {
    const found = identities.get(key(target.kind, target.id, target.version));
    check(found, "PROJECTION_DEPENDENCY_MISSING", "工作流引用的准确依赖未包含在投影中", 409);
    return { source, target, path: found.path, readOnly: true, ...(found.contentWithheld ? { contentWithheld: true } : {}), versionPolicy: target.kind === "bridge_tool" ? "live" : "fixed" };
  });
  add("project.json", jsonText({ contractVersion: "orchard.maintenance.v1", resources: entries.sort((a, b) => a.path.localeCompare(b.path)),
    dependencies: resolved.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) }));
  const result = Object.freeze(Object.fromEntries([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return Object.freeze({ hash: digest(canonicalJson(result)), bytes, files: result });
}
