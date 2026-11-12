import { AppError, check } from "../domain/errors.js";
import type { EncryptedEntry } from "../dictionaries/model.js";
import type { Store } from "../persistence/store.js";
import { decryptValue } from "../secrets/aead.js";
import { KeyringStore, resolveKeyringPath } from "../secrets/keyring.js";
import { LocalApiAuth } from "../web-bridge/auth.js";
import { configuredWebBridge } from "../web-bridge/configured.js";
import { loadKnowledgeBundle } from "./knowledge-bundle.js";
import { MaintenanceAssets } from "./maintenance-assets.js";
import type { MaintenanceRuntimeAuthority } from "./maintenance-composition.js";
import { MaintenanceSessions } from "./maintenance-sessions.js";
import { MaintenanceTaskHost } from "./maintenance-task-host.js";
import { assertQuerySafe, type QueryContext } from "./query-gateway.js";
import { WorkspaceInstaller } from "./workspace-installer.js";
import { WorkspaceProjectionSource } from "./workspace-projection-source.js";
import { assertProjectedToolSafe, assertScriptProjectionSafe } from "./workspace-projection.js";
import { homedir } from "node:os";
import type { ScriptDefinition } from "../domain/scripts.js";
import { canonicalJson } from "../persistence/files.js";
import { launchMaintenancePiSingle } from "./maintenance-pi-launcher.js";
import { maintenancePiFingerprint, readMaintenancePiConfig, runMaintenancePiTurn } from "./maintenance-pi-backend.js";
import type { MaintenanceTarget } from "./maintenance-protocol.js";
import { workflowProjectionIdentity } from "./workspace-identity.js";
import { MaintenanceToolGateway } from "./maintenance-tools.js";
import { MaintenanceService } from "./maintenance-service.js";

const localActor = "local";

export function createProductionMaintenance(store: Store): MaintenanceRuntimeAuthority {
  const bridge = configuredWebBridge(store);
  const assets = new MaintenanceAssets(store, bridge);
  const keyring = new KeyringStore(resolveKeyringPath(store.root));
  const apiAuth = new LocalApiAuth(store.root);
  const authorize = (actor: string) => {
    store.directoryLease.assert();
    check(actor === localActor, "UNAUTHORIZED", "维护工作区仅接受本机工作台身份", 403);
  };
  const knownSecrets = () => {
    const ring = keyring.load();
    const materials = new Map(ring?.keys.map(key => [key.keyId, Buffer.from(key.material, "base64")]) ?? []);
    const values = [apiAuth.token, ...Array.from(materials.values(), material => material.toString("base64"))];
    const rows = store.all<{ dictionary_id: string; entries_json: string }>("SELECT dictionary_id,entries_json FROM dictionary_versions WHERE kind='encrypted'");
    for (const row of rows) for (const [key, entry] of Object.entries(JSON.parse(row.entries_json) as Record<string, EncryptedEntry>)) {
      const envelope = entry.encryptedValue;
      const material = materials.get(envelope.keyId);
      check(material, "SECRET_KEY_MISSING", "无法核对维护投影中的敏感内容", 503);
      values.push(decryptValue(material, { keyId: envelope.keyId, dictionaryId: row.dictionary_id, key }, envelope));
    }
    return values;
  };
  const host = new MaintenanceTaskHost(store);
  const bundle = loadKnowledgeBundle();
  const piConfigPath = process.env.ORCHARD_MAINTENANCE_PI_CONFIG;
  const piConfig = () => {
    if (!piConfigPath) throw new AppError("BACKEND_UNAVAILABLE", "尚未配置经验证的维护模型后端", 503);
    return readMaintenancePiConfig(piConfigPath);
  };
  const sessions = new MaintenanceSessions(store, assets, {
    authorize, knownSecrets,
    backend(providerId, modelId, mode) {
      const config = piConfig();
      check(providerId === "pi-cli" && modelId === config.model && mode === "single" && store.provider(providerId)?.enabled,
        "BACKEND_UNAVAILABLE", "Pi 单轮维护后端不可用", 503);
      return { fingerprint: maintenancePiFingerprint(config), knowledgeHash: bundle.hash, toolPolicyVersion: "maintenance-pi-single-v1",
        references: { providerId, supportedVersions: [1], validatePayload() { throw new AppError("BACKEND_REFERENCE_INVALID", "单轮维护没有原生会话引用"); } } };
    },
    assertStopped: binding => host.assertStopped(binding),
    revokeTask: taskId => host.revokeTask(taskId),
  });
  const rules = Object.fromEntries(Object.entries(bundle.files).filter(([path]) => path !== ".agents/mcp.json"));
  const projectionContext: QueryContext = {
    actor: localActor, turnId: "workspace-projection", generation: 1,
    conversation: { id: "workspace-projection", actor_key: localActor, scenario: "workflow", owner_type: "project",
      owner_id: "local", owner_scope_json: "{}", mode: "single", provider_id: "", current_model_id: "",
      knowledge_hash: bundle.hash, contract_version: bundle.manifest.contractVersion, tool_policy_version: bundle.manifest.toolPolicyVersion,
      workspace_id: null, lifecycle: "active", usability: "usable", revision: 1, title: null, created_at: 0, updated_at: 0 },
  };
  const authorizeProjection = async (context: QueryContext) => {
    check(context === projectionContext, "UNAUTHORIZED", "维护投影需要宿主权限", 403);
    authorize(context.actor);
  };
  const projection = new WorkspaceProjectionSource(store, bridge, {
    authorize: authorizeProjection, authorizeProject: authorizeProjection, selectedTest: async () => null, knownSecrets,
  });
  const installer = new WorkspaceInstaller(store, { rules, knowledgeHash: bundle.hash,
    assertQuiescent: () => host.assertQuiescent(), source: signal => projection.collect(projectionContext, signal) });
  const boundary = { authorize, knownSecrets, assertQuiescent: () => host.assertQuiescent(),
    async synchronize(signal: AbortSignal) { await installer.synchronize(signal); } };
  const gateway = new MaintenanceToolGateway(store, new MaintenanceService(store, assets, boundary));
  const targetFor = (kind: MaintenanceTarget["kind"], id: string): MaintenanceTarget => {
    if (kind === "workflow_draft") {
      const draft = store.draft(id);
      return { kind, id: workflowProjectionIdentity(store, draft, store.files.readTree(draft.artifactPath).files), scope: { draftId: id } };
    }
    if (kind === "script_draft") return { kind, id, scope: { draftVersionId: store.script(id).currentDraftVersionId } };
    return { kind, id, scope: {} };
  };
  const running = new Set<string>();
  return {
    boundary,
    recover() {
      host.recover(sessions);
      // A queued task has never acquired a process or tool capability.
      store.exec("UPDATE agent_maintenance_tasks SET status='interrupted',ended_at=? WHERE status='queued' AND process_state='absent'", Date.now());
    },
    tasks: {
      start(actor, kind, owner, input) {
        authorize(actor);
        const target = targetFor(kind, owner);
        if (target.kind === "script_draft") {
          const { files, ...definition } = assets.capture(target).before.definition as ScriptDefinition;
          assertScriptProjectionSafe(definition, files, [...knownSecrets(), store.root, homedir()]);
        }
        if (target.kind === "browser_application") {
          const known = [...knownSecrets(), store.root, homedir()];
          for (const tool of bridge.authoringSnapshot(target.id).tools) {
            assertProjectedToolSafe(tool);
            assertQuerySafe(`${canonicalJson(tool)}\n`, known);
          }
        }
        const config = piConfig();
        const sessionId = sessions.create(actor, input.requestId, { target, mode: "single", providerId: "pi-cli", modelId: config.model });
        const session = sessions.view(actor, sessionId);
        const task = sessions.enqueue(actor, sessionId, { ...input, expectedRevision: session.revision, expectedGeneration: session.generation });
        if (task.status === "queued" && !running.has(task.id)) {
          running.add(task.id);
          void host.run({
            actor, sessionId, taskId: task.id, generation: task.generation, sessions, installer, gateway,
            async execute(claim, { registry, lease, bridge, signal }) {
              check(claim.fingerprint === maintenancePiFingerprint(config), "BACKEND_CHANGED", "Pi 配置已改变", 409);
              const { pi } = await launchMaintenancePiSingle({ ...config, registry, lease, bridge, workspace: installer.cwd });
              const prompt = [
                "You are working in the Orchard maintenance workspace. Read only the projected sources using the registered tools.",
                "Use mcp__orchard__submit_proposal to propose changes. Do not apply them. The user will review the proposal.",
                "Use the exact target and baseline below. Do not include credentials or host paths.",
                canonicalJson({ target: claim.target, baseline: claim.baseline }), "User request:", claim.input.prompt,
              ].join("\n");
              sessions.recordDisplay(claim.handle, await runMaintenancePiTurn(pi, config.model, prompt, signal));
            },
          }).catch(() => {
            store.exec("UPDATE agent_maintenance_tasks SET status='failed',error_code='MAINTENANCE_TASK_FAILED',ended_at=? WHERE id=? AND status='queued' AND process_state='absent'", Date.now(), task.id);
          }).finally(() => running.delete(task.id));
        }
        return task;
      },
      list: (actor, sessionId) => sessions.tasks(actor, sessionId),
    },
    authorizeUserRequest(request) {
      const headers = request.headers;
      const origin = `http://${headers.host}`;
      const sameOriginPage = headers["sec-fetch-site"] === "same-origin" &&
        (headers.origin === origin || request.method === "GET" && headers.origin === undefined);
      check(sameOriginPage || apiAuth.valid(headers["x-orchard-token"]), "UNAUTHORIZED", "维护操作需要本机工作台身份", 403);
      return localActor;
    },
    close: () => host.close(),
  };
}
