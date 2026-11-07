import { randomUUID } from "node:crypto";
import type { AgentModelConfig, AgentModelConfigView, RunAgentBinding, Workflow } from "../domain/types.js";
import { check } from "../domain/errors.js";
import { isModelEnabled } from "../domain/models.js";
import { assertSchema } from "../domain/validation.js";
import type { Store } from "../persistence/store.js";
import type { ProviderRegistry } from "../providers/registry.js";

const fields = {
  name: { type: "string", minLength: 1, maxLength: 100 },
  description: { type: "string", maxLength: 2000 },
  providerId: { type: "string", minLength: 1, maxLength: 200 },
  modelId: { type: "string", minLength: 1, maxLength: 200 },
  enabled: { type: "boolean" },
  requestId: { type: "string", minLength: 1, maxLength: 200 },
};
type ConfigRow = Omit<AgentModelConfig, "enabled"> & { enabled: number };
const columns = "id,name,description,provider_id AS providerId,model_id AS modelId,enabled,revision,created_at AS createdAt,updated_at AS updatedAt";
export interface AgentModelConfigReference {
  kind: "draft" | "version"; id: string; workflowId: string | null; name: string; version?: number; current?: boolean;
}

export class AgentModelConfigs {
  constructor(readonly store: Store, readonly providers: ProviderRegistry) {}
  get(id: string): AgentModelConfig {
    const row = this.store.one<ConfigRow>(`SELECT ${columns} FROM agent_model_configs WHERE id=?`, id);
    check(row, "NOT_FOUND", `Agent 模型配置不存在: ${id}`, 404);
    return { ...row, enabled: !!row.enabled };
  }
  private validateChoice(config: { providerId: string; modelId: string }) {
    const choice = this.providers.resolve(config), setting = this.providers.setting(choice.providerId);
    check(setting.models.some(model => model.id === choice.modelId && isModelEnabled(model)), "MODEL_NOT_FOUND", "请选择此 Provider 下已启用的模型", 404);
    return setting;
  }
  private uniqueName(name: string, id = "") {
    check(name.length > 0, "INVALID_NAME", "请输入模型配置名称");
    check(!this.store.one("SELECT id FROM agent_model_configs WHERE name=? COLLATE NOCASE AND id<>?", name, id), "AGENT_CONFIG_NAME_CONFLICT", "模型配置名称已存在", 409);
  }
  private recordRevision(config: AgentModelConfig) {
    this.store.exec("INSERT INTO agent_model_config_revisions(config_id,revision,name,description,provider_id,model_id,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)",
      config.id, config.revision, config.name, config.description, config.providerId, config.modelId, config.enabled ? 1 : 0, config.updatedAt);
  }
  create(value: unknown): AgentModelConfig {
    assertSchema(value, { type: "object", properties: fields, required: ["name", "providerId", "modelId", "requestId"], additionalProperties: false }, "模型配置");
    const input = value as { name: string; description?: string; providerId: string; modelId: string; enabled?: boolean; requestId: string };
    return this.store.command("agent-model-config:create", input.requestId, input, () => {
      const now = Date.now(), config: AgentModelConfig = {
        id: randomUUID(), name: input.name.trim(), description: input.description?.trim() ?? "", providerId: input.providerId, modelId: input.modelId,
        enabled: input.enabled ?? true, revision: 1, createdAt: now, updatedAt: now,
      };
      this.uniqueName(config.name); this.validateChoice(config);
      this.store.exec("INSERT INTO agent_model_configs(id,name,description,provider_id,model_id,enabled,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        config.id, config.name, config.description, config.providerId, config.modelId, config.enabled ? 1 : 0, config.revision, now, now);
      this.recordRevision(config);
      return config;
    });
  }
  update(id: string, value: unknown): AgentModelConfig {
    assertSchema(value, { type: "object", properties: { ...fields, expectedRevision: { type: "integer", minimum: 1 } }, required: ["expectedRevision", "requestId"], minProperties: 3, additionalProperties: false }, "模型配置");
    const input = value as Partial<Pick<AgentModelConfig, "name" | "description" | "providerId" | "modelId" | "enabled">> & { expectedRevision: number; requestId: string };
    return this.store.command(`agent-model-config:update:${id}`, input.requestId, input, () => {
      const current = this.get(id);
      check(current.revision === input.expectedRevision, "REVISION_CONFLICT", "模型配置已更新，请刷新后重试", 409);
      const { requestId, expectedRevision, ...patch } = input;
      const config = { ...current, ...patch, name: (input.name ?? current.name).trim(), description: (input.description ?? current.description).trim(), revision: current.revision + 1, updatedAt: Date.now() };
      this.uniqueName(config.name, id);
      if (config.enabled || config.providerId !== current.providerId || config.modelId !== current.modelId) this.validateChoice(config);
      this.store.exec("UPDATE agent_model_configs SET name=?,description=?,provider_id=?,model_id=?,enabled=?,revision=?,updated_at=? WHERE id=?",
        config.name, config.description, config.providerId, config.modelId, config.enabled ? 1 : 0, config.revision, config.updatedAt, id);
      this.recordRevision(config);
      return config;
    });
  }
  references(id: string) {
    this.get(id);
    const items: AgentModelConfigReference[] = [];
    const uses = (definition: Partial<Workflow>) => definition.defaults?.agent?.agentConfigId === id
      || Array.isArray(definition.nodes) && definition.nodes.some(node => node?.type === "agent" && node.config?.agentConfigId === id);
    for (const workflow of this.store.workflows()) for (const version of this.store.versions(workflow.id)) {
      if (uses(version.definition)) items.push({ kind: "version", id: version.id, workflowId: workflow.id, name: version.definition.name, version: version.number, current: version.id === workflow.currentVersionId });
    }
    for (const draft of this.store.drafts().filter(draft => draft.status === "draft" || draft.status === "publishing")) {
      let definition: Partial<Workflow>;
      try { definition = JSON.parse(this.store.files.readTree(draft.artifactPath).files["workflow.json"] ?? "{}"); } catch { continue; }
      if (definition && uses(definition)) items.push({ kind: "draft", id: draft.id, workflowId: draft.workflowId, name: definition.name ?? "未命名工作流" });
    }
    return { items, workflowCount: new Set(items.filter(item => item.kind === "version").map(item => item.workflowId)).size, draftCount: items.filter(item => item.kind === "draft").length };
  }
  view(id: string): AgentModelConfigView {
    const config = this.get(id), references = this.references(id);
    let unavailableReason: string | undefined;
    try {
      check(config.enabled, "AGENT_CONFIG_DISABLED", "配置已禁用");
      this.validateChoice(config);
      const provider = this.providers.views().find(provider => provider.id === config.providerId);
      check(provider?.readiness.state !== "unavailable", "PROVIDER_UNAVAILABLE", provider?.readiness.reason ?? "Provider 未就绪");
    } catch (error) { unavailableReason = (error as Error).message; }
    return { ...config, available: !unavailableReason, ...(unavailableReason ? { unavailableReason } : {}), workflowCount: references.workflowCount, draftCount: references.draftCount };
  }
  list(enabled?: boolean) {
    return { items: this.store.all<{ id: string; enabled: number }>("SELECT id,enabled FROM agent_model_configs ORDER BY updated_at DESC,name")
      .filter(row => enabled === undefined || !!row.enabled === enabled).map(row => this.view(row.id)) };
  }
  resolveWorkflow(workflow: Workflow): RunAgentBinding[] {
    const configs = new Map<string, { config: AgentModelConfig; providerRevision: number }>();
    return workflow.nodes.filter(node => node.type === "agent").map(node => {
      const id = node.config.agentConfigId ?? workflow.defaults?.agent?.agentConfigId;
      check(id, "AGENT_CONFIG_REQUIRED", `${node.name} 缺少 Agent 模型配置`);
      let resolved = configs.get(id);
      if (!resolved) {
        const config = this.get(id);
        check(config.enabled, "AGENT_CONFIG_DISABLED", `Agent 模型配置已禁用: ${config.name}`);
        const setting = this.validateChoice(config);
        resolved = { config, providerRevision: setting.revision }; configs.set(id, resolved);
      }
      return { nodeId: node.id, configId: id, configRevision: resolved.config.revision, name: resolved.config.name, providerId: resolved.config.providerId, modelId: resolved.config.modelId, providerRevision: resolved.providerRevision };
    });
  }
  saveBindings(runId: string, bindings: RunAgentBinding[]) {
    for (const binding of bindings) this.store.exec("INSERT INTO run_agent_bindings(run_id,node_id,config_id,config_revision,provider_revision,created_at) VALUES(?,?,?,?,?,?)",
      runId, binding.nodeId, binding.configId, binding.configRevision, binding.providerRevision, Date.now());
  }
  bindings(runId: string): RunAgentBinding[] {
    return this.store.all<RunAgentBinding>(`SELECT b.node_id AS nodeId,b.config_id AS configId,b.config_revision AS configRevision,b.provider_revision AS providerRevision,
      r.name,r.provider_id AS providerId,r.model_id AS modelId FROM run_agent_bindings b
      JOIN agent_model_config_revisions r ON r.config_id=b.config_id AND r.revision=b.config_revision WHERE b.run_id=? ORDER BY b.node_id`, runId);
  }
}
