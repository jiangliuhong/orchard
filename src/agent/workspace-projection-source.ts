import { homedir } from "node:os";
import { configCoordinator } from "../config-git/coordinator.js";
import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { WebBridgeConfig } from "../web-bridge/config.js";
import { AssetQueryHost, type AssetQueryBoundary } from "./asset-query-host.js";
import type { AssetSelector, QueryContext } from "./query-gateway.js";
import { workflowProjectionIdentity } from "./workspace-identity.js";
import { buildWorkspaceProjection, workflowProjectionDependencies, PROJECTION_LIMITS, type ProjectionApplication, type ProjectionResource, type WorkspaceProjection } from "./workspace-projection.js";

export interface WorkspaceProjectionBoundary extends AssetQueryBoundary {
  /** Must authorize reading the WHOLE shared project, including application config.
   * Per-resource write scope or permission to read only the selected owner is not
   * enough. No partial/filtered project may be installed into a shared workspace.
   */
  authorizeProject(context: QueryContext): Promise<void>;
}

/** Read-only adapter over existing business APIs. Both configuration barriers are
 * retained across awaited authorization and compilation; controlled page writes,
 * restores and business activities fail with CONFIG_BUSY instead of interleaving.
 * The data-directory lease still supplies inter-process exclusion. This is not a
 * workspace task lease, an installer or a durable synchronization receipt.
 */
export class WorkspaceProjectionSource {
  private readonly assets: AssetQueryHost;
  constructor(private readonly store: Store, private readonly bridge: WebBridgeConfig, private readonly boundary: WorkspaceProjectionBoundary) {
    this.assets = new AssetQueryHost(store, bridge, boundary);
  }

  async collect(context: QueryContext, signal: AbortSignal): Promise<WorkspaceProjection> {
    signal.throwIfAborted();
    const coordinator = configCoordinator(this.store);
    const action = () => this.collectLocked(context, signal);
    // Production shares one coordinator; independently constructed adapters must
    // still protect BOTH stores. These are reject-on-busy barriers, not wait locks.
    return coordinator.withRead(() => this.bridge.coordinator === coordinator ? action() : this.bridge.coordinator.withRead(action));
  }

  private async collectLocked(context: QueryContext, signal: AbortSignal): Promise<WorkspaceProjection> {
    await this.boundary.authorizeProject(context); signal.throwIfAborted();
    const drafts = this.store.drafts().filter(draft => draft.status !== "published");
    check(drafts.every(draft => draft.status === "draft"), "PROJECTION_SOURCE_BUSY", "工作流草稿状态尚未稳定", 409);
    const workflows = this.store.workflows().filter(workflow => workflow.currentVersionId);
    const scripts = this.store.scripts().filter(script => script.status !== "archived");
    const applications = this.bridge.applications();
    const count = drafts.length + workflows.length + scripts.reduce((n, script) => n + Number(!!script.currentDraftVersionId) + Number(!!script.currentPublishedVersionId), 0)
      + applications.length + this.bridge.tools().length;
    check(count <= PROJECTION_LIMITS.resources, "PROJECTION_TOO_LARGE", "投影资源数量超限");
    // Bound retained source as well as final output. Read at most one resource
    // beyond this budget, rather than retaining thousands of full artifact trees.
    let sourceBytes = 0;
    const reserve = (value: unknown) => {
      sourceBytes += Buffer.byteLength(canonicalJson(value));
      check(sourceBytes <= PROJECTION_LIMITS.totalBytes, "PROJECTION_TOO_LARGE", "投影输入快照总字节数超限");
    };
    const resources: ProjectionResource[] = [];
    const selectors: AssetSelector[] = [];
    const get = async (selector: AssetSelector) => {
      const snapshot = await this.assets.get(context, selector);
      signal.throwIfAborted(); reserve(snapshot); selectors.push(selector);
      return snapshot;
    };
    for (const draft of drafts) {
      const snapshot = await get({ kind: "workflow", id: draft.workflowId ?? draft.id, version: `draft:${draft.id}` });
      const id = workflowProjectionIdentity(this.store, draft, snapshot.files);
      resources.push({ state: "draft", draftId: draft.id, snapshot: { ...snapshot, id } });
    }
    for (const workflow of workflows) {
      const snapshot = await get({ kind: "workflow", id: workflow.id, version: workflow.currentVersionId });
      let definition: { id?: string } | null = null;
      try { definition = JSON.parse(snapshot.files["workflow.json"]!); } catch { /* Reject below. */ }
      check(definition?.id === workflow.id && canonicalJson(definition) === canonicalJson(snapshot.definition), "PROJECTION_VERSION_MISMATCH", "发布工作流身份或定义与受管源码不一致", 409);
      resources.push({ state: "published", snapshot });
    }
    for (const script of scripts) {
      for (const [state, version] of [["draft", script.currentDraftVersionId], ["published", script.currentPublishedVersionId]] as const) {
        if (!version) continue;
        const snapshot = await get({ kind: "script", id: script.id, version });
        const record = this.store.scriptVersion(version);
        check(record.status === state, "PROJECTION_VERSION_MISMATCH", "脚本当前版本指针与版本状态不一致", 409);
        resources.push({ state, snapshot: { ...snapshot, validation: record.validation } });
      }
    }
    // Script definitions have no cross-library dependency edges in v1. Structured
    // workflow references are the complete roots; local imports stay in that tree.
    const included = new Set(resources.filter(resource => resource.snapshot.kind === "script").map(resource => canonicalJson([resource.snapshot.id, resource.snapshot.version])));
    for (const resource of [...resources]) {
      if (resource.snapshot.kind !== "workflow") continue;
      const parsed = workflowProjectionDependencies(resource.snapshot.files["workflow.json"]!);
      for (const dependency of parsed.items) {
        if (dependency.kind !== "script") continue;
        const identity = canonicalJson([dependency.id, dependency.version]);
        await this.assets.authorize(context, { kind: "script", id: dependency.id, version: dependency.version }); signal.throwIfAborted();
        const version = this.store.scriptVersion(dependency.version!);
        check(version.scriptId === dependency.id && version.status === "published", "PROJECTION_DEPENDENCY_INVALID", "工作流必须引用所属脚本的准确发布版本", 409);
        if (included.has(identity)) continue;
        check(resources.length + applications.length + this.bridge.tools().length < PROJECTION_LIMITS.resources, "PROJECTION_TOO_LARGE", "投影依赖数量超限");
        const snapshot = await get({ kind: "script", id: dependency.id, version: dependency.version });
        resources.push({ state: "historical", snapshot: { ...snapshot, validation: version.validation } }); included.add(identity);
      }
    }
    const projectedApplications: ProjectionApplication[] = [];
    for (const application of applications) {
      const snapshot = this.bridge.authoringSnapshot(application.id);
      const tools = [];
      for (const tool of snapshot.tools) {
        const selected = await get({ kind: "bridge_tool", id: `${application.id}/${tool.toolId}`, version: digest(canonicalJson(tool)) });
        tools.push(selected);
      }
      const definition = { id: application.id, name: application.name, enabled: application.enabled,
        environments: snapshot.environments.map(({ id, key, origin, enabled }) => ({ id, ...(key === undefined ? {} : { key }), origin, enabled })) };
      reserve(definition);
      projectedApplications.push({ id: application.id, revision: snapshot.hash, definition, tools });
    }
    // Authorization can change while an external identity check is awaited. Do not
    // return a completed project after revocation, even if all source reads passed.
    for (const selector of selectors) {
      await this.assets.authorize(context, selector);
      signal.throwIfAborted();
    }
    await this.boundary.authorizeProject(context); signal.throwIfAborted();
    return buildWorkspaceProjection({ resources, applications: projectedApplications, knownSecrets: [...this.boundary.knownSecrets(), this.store.root, homedir()] });
  }
}
