import { check } from "../domain/errors.js";
import type { Workflow } from "../domain/types.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import type { WebBridgeConfig } from "../web-bridge/config.js";
import { assertQuerySafe, type AssetKind, type AssetReference, type AssetSelector, type AssetSnapshot, type AssetSummary, type PlatformQueryHost, type QueryContext } from "./query-gateway.js";

export interface AssetQueryBoundary {
  /** The current app has a local identity boundary, not invented tenant ACLs.
   * The production caller must supply its identity/owner authorizer here. */
  authorize(context: QueryContext, resource?: AssetSelector): Promise<void>;
  /** Server-selected current-owner context, with sensitive/no-retention policy already applied. */
  selectedTest(context: QueryContext): Promise<unknown>;
  knownSecrets(): readonly string[];
}

const identity = (value: AssetSelector) => canonicalJson({ kind: value.kind, id: value.id, version: value.version ?? null });
function page<T>(items: T[], cursor: string | undefined, limit: number, scope: unknown): { items: T[]; nextCursor: string | null } {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 50, "INVALID_REQUEST", "分页大小无效");
  const hash = digest(canonicalJson({ scope, items }));
  let offset = 0;
  if (cursor) {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { check(false, "INVALID_CURSOR", "查询游标无效"); }
    const value = parsed as { hash?: unknown; offset?: unknown } | null;
    check(value && value.hash === hash && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= items.length, "QUERY_CURSOR_STALE", "查询范围或资源已变化，请重新分页", 409);
    offset = Number(value.offset);
  }
  const end = offset + limit;
  return { items: items.slice(offset, end), nextCursor: end < items.length ? Buffer.from(canonicalJson({ hash, offset: end })).toString("base64url") : null };
}

/** Read-only business adapter. Uses validated content-addressed resource trees,
 * never arbitrary host paths, runtime records, dictionary values or execution APIs.
 */
export class AssetQueryHost implements PlatformQueryHost {
  constructor(private readonly store: Store, private readonly bridge: WebBridgeConfig, private readonly boundary: AssetQueryBoundary) {}
  authorize(context: QueryContext, resource?: AssetSelector) { return this.boundary.authorize(context, resource); }
  selectedTest(context: QueryContext) { return this.boundary.selectedTest(context); }
  assertSafe(value: unknown) { assertQuerySafe(value, this.boundary.knownSecrets()); }

  private workflowDraft(id: string): AssetSnapshot {
    const draft = this.store.draft(id);
    const { files } = this.store.files.readTree(draft.artifactPath);
    let definition: Partial<Workflow> | null = null;
    try { definition = JSON.parse(files["workflow.json"]!); } catch { /* Incomplete drafts are still inspectable as source. */ }
    const name = typeof definition?.name === "string" ? definition.name : draft.id;
    return { kind: "workflow", id: draft.workflowId ?? draft.id, version: `draft:${draft.id}`, revision: String(draft.revision), name, definition, files, validation: draft.validation };
  }
  private workflowVersion(id: string): AssetSnapshot {
    const version = this.store.version(id);
    return { kind: "workflow", id: version.workflowId, version: version.id, revision: version.contentHash,
      name: version.definition.name, definition: version.definition, files: this.store.files.readTree(version.artifactPath).files };
  }
  private script(id: string, versionId?: string): AssetSnapshot {
    const script = this.store.script(id);
    const selected = versionId ?? script.currentDraftVersionId ?? script.currentPublishedVersionId;
    check(selected, "NOT_FOUND", "脚本没有可读取版本", 404);
    const version = this.store.scriptVersion(selected);
    check(version.scriptId === id, "NOT_FOUND", "脚本版本不属于指定资源", 404);
    const { files, ...definition } = this.store.scriptDefinition(id, selected);
    return { kind: "script", id, version: selected, revision: String(version.revision), name: definition.name, definition, files };
  }
  private tool(id: string, version?: string): AssetSnapshot {
    const tool = this.bridge.tools().find(tool => `${tool.application}/${tool.toolId}` === id);
    check(tool, "NOT_FOUND", "浏览器工具不存在", 404);
    const revision = digest(canonicalJson(tool));
    check(!version || version === revision, "REVISION_CONFLICT", "工具配置版本已变化", 409);
    // Validated definitions contain credential declarations/references, not resolved values.
    // Conservatively fail on suspicious embedded source/configuration; never call the tool.
    return { kind: "bridge_tool", id, version: revision, revision, name: tool.toolId, definition: tool, files: {} };
  }

  async get(context: QueryContext, resource: AssetSelector): Promise<AssetSnapshot> {
    await this.authorize(context, resource);
    if (resource.kind === "script") return this.script(resource.id, resource.version);
    if (resource.kind === "bridge_tool") return this.tool(resource.id, resource.version);
    check(resource.kind === "workflow", "INVALID_REQUEST", "资源类型无效");
    if (resource.version?.startsWith("draft:")) {
      const snapshot = this.workflowDraft(resource.version.slice(6));
      check(snapshot.id === resource.id, "NOT_FOUND", "草稿不属于指定工作流", 404);
      return snapshot;
    }
    const selected = resource.version ?? this.store.workflows().find(item => item.id === resource.id)?.currentVersionId;
    check(selected, "NOT_FOUND", "工作流版本不存在，请指定草稿或发布版本", 404);
    const snapshot = this.workflowVersion(selected);
    check(snapshot.id === resource.id, "NOT_FOUND", "发布版本不属于指定工作流", 404);
    return snapshot;
  }
  async current(context: QueryContext): Promise<AssetSnapshot> {
    await this.authorize(context);
    const conversation = context.conversation;
    if (conversation.scenario === "workflow" && conversation.owner_type === "draft") return this.workflowDraft(conversation.owner_id);
    if (conversation.scenario === "script" && conversation.owner_type === "script") {
      const scope = JSON.parse(conversation.owner_scope_json) as { draftVersionId?: string };
      check(scope.draftVersionId && this.store.script(conversation.owner_id).currentDraftVersionId === scope.draftVersionId, "OWNER_UNAVAILABLE", "固定脚本草稿已被替换", 409);
      return this.script(conversation.owner_id, scope.draftVersionId);
    }
    if (conversation.scenario === "web-bridge" && conversation.owner_type === "application") {
      const snapshot = this.bridge.authoringSnapshot(conversation.owner_id);
      // Do not include browser profile IDs, extension registration or runtime availability.
      return { kind: "bridge_tool", id: conversation.owner_id, revision: snapshot.hash, name: snapshot.application.name,
        definition: { application: { id: snapshot.application.id, name: snapshot.application.name, enabled: snapshot.application.enabled },
          environments: snapshot.environments.map(({ id, origin, enabled }) => ({ id, origin, enabled })), tools: snapshot.tools }, files: {} };
    }
    check(false, "OWNER_UNAVAILABLE", "维护对象类型与场景不一致", 409);
  }

  async search(context: QueryContext, input: { kind?: AssetKind; query: string; cursor?: string; limit: number }) {
    await this.authorize(context);
    const items: AssetSummary[] = [];
    // Metadata only. Full source is read only by explicit get/read_file calls.
    if (!input.kind || input.kind === "workflow") {
      for (const draft of this.store.drafts()) {
        const snapshot = this.workflowDraft(draft.id);
        items.push({ kind: snapshot.kind, id: snapshot.id, version: snapshot.version, name: snapshot.name, revision: snapshot.revision });
      }
      for (const workflow of this.store.workflows()) if (workflow.currentVersionId) {
        const version = this.store.version(workflow.currentVersionId);
        items.push({ kind: "workflow", id: workflow.id, name: workflow.name, version: version.id, revision: version.contentHash });
      }
    }
    if (!input.kind || input.kind === "script") for (const script of this.store.scripts().filter(item => item.status !== "archived")) {
      const selected = script.currentDraftVersionId ?? script.currentPublishedVersionId;
      if (selected) items.push({ kind: "script", id: script.id, name: script.name, version: selected, revision: String(this.store.scriptVersion(selected).revision) });
    }
    if (!input.kind || input.kind === "bridge_tool") for (const tool of this.bridge.tools()) {
      const revision = digest(canonicalJson(tool));
      items.push({ kind: "bridge_tool", id: `${tool.application}/${tool.toolId}`, name: tool.toolId, version: revision, revision });
    }
    const query = input.query.toLocaleLowerCase();
    const visible: AssetSummary[] = [];
    for (const item of items.filter(item => `${item.id} ${item.name}`.toLocaleLowerCase().includes(query)).sort((a, b) => identity(a).localeCompare(identity(b)))) {
      await this.authorize(context, item); visible.push(item);
    }
    return page(visible, input.cursor, input.limit, { kind: input.kind ?? null, query });
  }

  async references(context: QueryContext, resource: AssetSelector, cursor: string | undefined, limit: number) {
    await this.authorize(context, resource);
    // Verify an explicit target really exists (and has the requested version).
    await this.get(context, resource);
    const workflows: AssetSnapshot[] = this.store.drafts().map(draft => this.workflowDraft(draft.id));
    for (const workflow of this.store.workflows()) for (const version of this.store.versions(workflow.id)) workflows.push(this.workflowVersion(version.id));
    const relationships: AssetReference[] = [];
    const incompleteSources: AssetSelector[] = [];
    for (const snapshot of workflows) {
      const workflow = snapshot.definition as Partial<Workflow> | null;
      const source = { kind: snapshot.kind, id: snapshot.id, version: snapshot.version };
      let incomplete = snapshot.validation?.valid === false || !Array.isArray(workflow?.nodes);
      for (const node of Array.isArray(workflow?.nodes) ? workflow.nodes : []) {
        if (!node || typeof node !== "object" || !node.config || typeof node.config !== "object") { incomplete = true; continue; }
        let target: AssetSelector | undefined;
        if (node.type === "script") {
          if (typeof node.config.scriptId !== "string" || !node.config.scriptId || typeof node.config.scriptVersionId !== "string" || !node.config.scriptVersionId) { incomplete = true; continue; }
          target = { kind: "script", id: node.config.scriptId, version: node.config.scriptVersionId };
        }
        if (node.type === "web-bridge") {
          if (typeof node.config.application !== "string" || !node.config.application || typeof node.config.tool !== "string" || !node.config.tool) { incomplete = true; continue; }
          target = { kind: "bridge_tool", id: `${node.config.application}/${node.config.tool}` };
        }
        if (!target) continue;
        const matches = (value: AssetSelector) => value.kind === resource.kind && value.id === resource.id && (!resource.version || value.version === resource.version);
        if (matches(source) || matches(target)) {
          await this.authorize(context, source); await this.authorize(context, target);
          relationships.push({ source, target });
        }
      }
      if (incomplete) { await this.authorize(context, source); incompleteSources.push(source); }
    }
    const unique = [...new Map(relationships.map(item => [canonicalJson(item), item])).values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    return { ...page(unique, cursor, limit, { resource, incompleteSources }), incomplete: incompleteSources.length > 0,
      incompleteSources: incompleteSources.slice(0, 10), incompleteSourceCount: incompleteSources.length };
  }
}
