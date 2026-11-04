import { accessSync, constants, readFileSync, mkdtempSync, rmSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { executeProcess } from "../runtime/process.js";
import { check, AppError, failure } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { AgentChoice, JsonSchema, Model, ModelVerification, ProviderCapabilities, ProviderSetting, ProviderView, Workflow } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { isModelEnabled, visibleModels } from "../domain/models.js";
import { readCodexConfig, readCodexModels } from "./codex-config.js";

export interface ProviderEvent { type: string; payload: unknown }
export interface TurnRequest {
  modelId: string; prompt: string; schema?: JsonSchema; signal: AbortSignal; cwd: string; timeoutMs?: number;
  emit: (event: ProviderEvent) => void;
}
export interface ProviderResult { output: unknown; modelId: string; modelSource?: "reported" | "requested"; providerId: string; usage?: unknown }
export interface AgentProvider {
  id: string; name: string; capabilities: ProviderCapabilities; configSchema: JsonSchema;
  defaultConfig?: Record<string, unknown>;
  detect(setting: ProviderSetting): Promise<ProviderView["readiness"]>;
  models(setting: ProviderSetting, cwd: string): Promise<{ models: Model[]; warning?: string }>;
  turn(setting: ProviderSetting, request: TurnRequest): Promise<ProviderResult>;
}
const configSchema: JsonSchema = { type: "object", required: ["executable"], properties: { executable: { type: "string", minLength: 1 } }, additionalProperties: false };
function discoveredExecutable(command: string) {
  const paths = [...(process.env.PATH ?? "").split(":"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  try {
    const base = join(homedir(), ".nvm/versions/node");
    readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).forEach(name => paths.push(join(base, name, "bin")));
  } catch { /* nvm is optional. */ }
  for (const directory of paths.filter(Boolean)) {
    const target = join(directory, command);
    try { accessSync(target, constants.X_OK); if (isAbsolute(target)) return target; } catch { /* Try next directory. */ }
  }
  return `/usr/local/bin/${command}`;
}
export class ProviderRegistry {
  private readonly adapters = new Map<string, AgentProvider>();
  private readonly states = new Map<string, ProviderView["readiness"]>();
  private readonly verifications = new Map<string, { controller: AbortController; finished: Promise<void> }>();
  constructor(readonly store: Store) {}
  register(provider: AgentProvider, executable = discoveredExecutable(provider.id.replace("-cli", ""))) {
    check(!this.adapters.has(provider.id), "DUPLICATE_PROVIDER", "Provider ID 已注册");
    this.adapters.set(provider.id, provider);
    if (!this.store.provider(provider.id)) this.store.saveProvider({ id: provider.id, enabled: false, config: provider.defaultConfig ?? { executable }, models: [], defaultModel: "", revision: 1, updatedAt: Date.now() });
    return this;
  }
  adapter(id: string) { const adapter = this.adapters.get(id); check(adapter, "PROVIDER_NOT_FOUND", `Provider 未注册: ${id}`); return adapter; }
  views(): ProviderView[] { return [...this.adapters.values()].map(p => {
    const setting = this.store.provider(p.id)!;
    return { ...setting, models: visibleModels(setting.models), name: p.name, configSchema: p.configSchema, capabilities: p.capabilities, readiness: this.states.get(p.id) ?? { state: "unknown" } };
  }); }
  setting(id: string) { this.adapter(id); return this.store.provider(id)!; }
  update(id: string, input: unknown) {
    assertSchema(input, {
      type: "object", properties: { enabled: { type: "boolean" }, config: this.adapter(id).configSchema, defaultModel: { type: "string", maxLength: 200 },
        models: { type: "array", maxItems: 500, items: { type: "object", required: ["id", "name", "source"], properties: { id: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, source: { enum: ["configured", "discovered"] }, enabled: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false,
    }, "Provider 设置");
    const current = this.setting(id), data = input as Partial<ProviderSetting>;
    const next = { ...current, ...data, id, revision: current.revision + 1, updatedAt: Date.now() };
    if (data.models) {
      check(new Set(data.models.map(model => model.id)).size === data.models.length, "MODEL_CONFLICT", "模型 ID 不能重复");
      const merged = new Map(current.models.map(model => [model.id, model]));
      for (const model of data.models) {
        const previous = merged.get(model.id);
        merged.set(model.id, { ...model, enabled: model.enabled ?? previous?.enabled ?? true, ...(previous?.deleted ? { deleted: true, enabled: false } : {}) });
      }
      next.models = [...merged.values()];
      check(visibleModels(next.models).length <= 500, "MODEL_LIMIT", "每个 Provider 最多保留 500 个模型");
    }
    assertSchema(next.config, this.adapter(id).configSchema);
    if (Object.hasOwn(next.config, "executable")) check(typeof next.config.executable === "string" && isAbsolute(next.config.executable) && !next.config.executable.includes("\0"), "INVALID_EXECUTABLE", "请配置 CLI 绝对路径");
    for (const model of [next.defaultModel, ...next.models.map(m => m.id)]) check(!/^\s*-|[\0\r\n]/.test(model), "INVALID_MODEL", "模型 ID 无效");
    const defaultEntry = next.models.find(model => model.id === next.defaultModel);
    if (defaultEntry && !isModelEnabled(defaultEntry)) {
      check(!data.defaultModel, "MODEL_DISABLED", "不能将已禁用或删除的模型设置为默认模型");
      next.defaultModel = "";
    }
    this.store.saveProvider(next);
    if (data.config) this.states.delete(id);
    return this.views().find(p => p.id === id)!;
  }
  async detect(id: string) {
    const setting = this.setting(id), state = await this.adapter(id).detect(setting);
    if (this.setting(id).revision === setting.revision) this.states.set(id, state);
    return state;
  }
  async models(id: string) {
    const current = this.setting(id);
    const result = await this.adapter(id).models(current, this.store.root);
    check(this.setting(id).revision === current.revision, "SETTINGS_CONFLICT", "配置已更新，请重新刷新模型");
    const merged = new Map(current.models.map(model => [model.id, model]));
    for (const discovered of result.models) {
      const previous = merged.get(discovered.id);
      merged.set(discovered.id, { ...discovered, ...previous, enabled: previous?.enabled ?? true });
    }
    const updated = this.saveModels(current, [...merged.values()]);
    return { models: updated.models, defaultModel: updated.defaultModel, revision: updated.revision, warning: result.warning };
  }
  modelList(id: string) { return visibleModels(this.setting(id).models); }
  get activeVerificationCount() { return this.verifications.size; }
  async verifyModel(id: string, modelId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ModelVerification> {
    const setting = this.setting(id), adapter = this.adapter(id);
    check(setting.enabled, "PROVIDER_DISABLED", "请先启用 Provider，再验证模型");
    check(modelId.trim().length > 0 && modelId.length <= 200 && !/^\s*-|[\0\r\n]/.test(modelId), "INVALID_MODEL", "模型 ID 无效");
    const model = setting.models.find(candidate => candidate.id === modelId && !candidate.deleted);
    if (!model) throw new AppError("MODEL_NOT_FOUND", "模型不存在", 404);
    check(!this.verifications.has(id), "MODEL_VERIFICATION_BUSY", "该 Provider 已有模型正在验证，请等待或取消后重试");
    const timeoutMs = Math.min(options.timeoutMs ?? 60000, 60000);
    check(Number.isInteger(timeoutMs) && timeoutMs > 0, "INVALID_TIMEOUT", "验证超时时间无效");
    const startedAt = Date.now(), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let finished!: () => void;
    this.verifications.set(id, { controller, finished: new Promise<void>(resolve => { finished = resolve; }) });
    const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "模型验证超时，请检查连接或稍后重试")), timeoutMs);
    const resultBase = () => ({ providerId: id, modelId, providerRevision: setting.revision, checkedAt: Date.now(), durationMs: Date.now() - startedAt });
    try {
      signal.throwIfAborted();
      const readiness = await adapter.detect(setting);
      signal.throwIfAborted();
      check(this.setting(id).revision === setting.revision, "SETTINGS_CONFLICT", "配置已改变，请重新验证");
      this.states.set(id, readiness);
      check(readiness.state === "ready", "PROVIDER_UNAVAILABLE", readiness.reason ?? "Provider 未就绪");
      const response = await adapter.turn(setting, {
        modelId, prompt: "Reply with only OK. Do not use tools or perform any other task.",
        signal, cwd: this.store.root, timeoutMs, emit: () => {},
      });
      signal.throwIfAborted();
      check(this.setting(id).revision === setting.revision, "SETTINGS_CONFLICT", "配置已改变，本次结果已失效，请重新验证");
      check(typeof response.output === "string" && response.output.trim().length > 0, "EMPTY_MODEL_RESPONSE", "模型未返回有效文本");
      return {
        ...resultBase(), status: "available", responsePreview: response.output.trim().slice(0, 160),
        ...(response.modelSource === "reported" ? { actualModelId: response.modelId } : {}),
      };
    } catch (error) {
      const detail = failure(signal.aborted
        ? signal.reason instanceof AppError ? signal.reason : new AppError("CANCELLED", "模型验证已取消")
        : error);
      return {
        ...resultBase(), status: signal.aborted && detail.code !== "TIMEOUT" ? "cancelled" : "failed",
        error: { ...detail, message: detail.message.slice(0, 2000) },
      };
    } finally {
      clearTimeout(timer); this.verifications.delete(id); finished();
    }
  }
  async closeVerifications() {
    const active = [...this.verifications.values()];
    for (const verification of active) verification.controller.abort(new AppError("CANCELLED", "服务关闭，模型验证已取消"));
    await Promise.all(active.map(verification => verification.finished));
  }
  addModel(id: string, input: unknown) {
    assertSchema(input, {
      type: "object", required: ["id"], properties: {
        id: { type: "string", minLength: 1, maxLength: 200 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        enabled: { type: "boolean" },
      }, additionalProperties: false,
    }, "模型");
    const data = input as { id: string; name?: string; enabled?: boolean };
    const modelId = data.id.trim();
    check(modelId.length > 0 && !/^-|\s|\0/.test(modelId), "INVALID_MODEL", "模型 ID 不能为空、包含空白或以减号开头");
    const setting = this.setting(id), previous = setting.models.find(model => model.id === modelId);
    check(!previous || previous.deleted, "MODEL_CONFLICT", "该模型 ID 已存在");
    const model: Model = { id: modelId, name: data.name?.trim() || modelId, source: "configured", enabled: data.enabled ?? true };
    return this.saveModels(setting, [...setting.models.filter(candidate => candidate.id !== modelId), model]);
  }
  updateModel(id: string, modelId: string, input: unknown) {
    assertSchema(input, {
      type: "object", minProperties: 1, properties: {
        enabled: { type: "boolean" }, name: { type: "string", minLength: 1, maxLength: 200 },
      }, additionalProperties: false,
    }, "模型设置");
    const setting = this.setting(id), model = setting.models.find(candidate => candidate.id === modelId && !candidate.deleted);
    if (!model) throw new AppError("MODEL_NOT_FOUND", "模型不存在", 404);
    const data = input as { enabled?: boolean; name?: string };
    const updated = { ...model, ...data, ...(data.name ? { name: data.name.trim() || model.name } : {}) };
    return this.saveModels(setting, setting.models.map(candidate => candidate.id === modelId ? updated : candidate));
  }
  deleteModel(id: string, modelId: string) {
    const setting = this.setting(id), model = setting.models.find(candidate => candidate.id === modelId);
    if (!model) throw new AppError("MODEL_NOT_FOUND", "模型不存在", 404);
    if (model.deleted) return this.views().find(provider => provider.id === id)!;
    return this.saveModels(setting, setting.models.map(candidate => candidate.id === modelId ? { ...candidate, enabled: false, deleted: true } : candidate));
  }
  private saveModels(setting: ProviderSetting, models: Model[]): ProviderView {
    check(visibleModels(models).length <= 500, "MODEL_LIMIT", "每个 Provider 最多保留 500 个模型");
    const defaultEntry = models.find(model => model.id === setting.defaultModel);
    this.store.saveProvider({
      ...setting, models, defaultModel: defaultEntry && !isModelEnabled(defaultEntry) ? "" : setting.defaultModel,
      revision: setting.revision + 1, updatedAt: Date.now(),
    });
    return this.views().find(provider => provider.id === setting.id)!;
  }
  resolve(choice: AgentChoice, defaults?: AgentChoice): { providerId: string; modelId: string } {
    const providerId = choice.providerId ?? defaults?.providerId;
    check(providerId, "PROVIDER_REQUIRED", "请选择 Provider");
    const setting = this.setting(providerId);
    check(setting.enabled, "PROVIDER_DISABLED", `Provider 已禁用: ${providerId}`);
    const modelId = choice.modelId ?? (choice.providerId && choice.providerId !== defaults?.providerId ? undefined : defaults?.modelId) ?? setting.defaultModel;
    check(modelId && !/^\s*-|[\0\r\n]/.test(modelId), "MODEL_REQUIRED", `请为 ${providerId} 选择明确模型`);
    const model = setting.models.find(candidate => candidate.id === modelId);
    check(!model?.deleted, "MODEL_DELETED", `模型已从列表删除: ${modelId}`);
    check(!model || isModelEnabled(model), "MODEL_DISABLED", `模型已禁用: ${modelId}`);
    return { providerId, modelId };
  }
  async ready(choice: AgentChoice, defaults?: AgentChoice) {
    const effective = this.resolve(choice, defaults), setting = this.setting(effective.providerId);
    const state = await this.adapter(effective.providerId).detect(setting);
    check(this.setting(effective.providerId).enabled, "PROVIDER_DISABLED", "Provider 已禁用");
    check(this.setting(effective.providerId).revision === setting.revision, "SETTINGS_CONFLICT", "Provider 配置已改变，请重试");
    this.states.set(setting.id, state);
    check(state.state === "ready", "PROVIDER_UNAVAILABLE", state.reason ?? "Provider 未就绪");
    return { ...effective, setting };
  }
  async freeze(workflow: Workflow): Promise<Workflow> {
    const frozen = structuredClone(workflow);
    for (const node of frozen.nodes) if (node.type === "agent") {
      const choice = await this.ready(node.config, frozen.defaults?.agent);
      node.config.providerId = choice.providerId; node.config.modelId = choice.modelId;
    }
    return frozen;
  }
  async run(choice: AgentChoice, request: Omit<TurnRequest, "modelId">) {
    const effective = await this.ready(choice);
    request.signal.throwIfAborted();
    request.emit({ type: "provider.started", payload: { providerId: effective.providerId, requestedModel: effective.modelId, revision: effective.setting.revision, executable: effective.setting.config.executable } });
    const result = await this.adapter(effective.providerId).turn(effective.setting, { ...request, modelId: effective.modelId });
    request.signal.throwIfAborted();
    if (request.schema !== undefined) assertSchema(result.output, request.schema, "Agent 输出");
    request.emit({ type: "provider.completed", payload: result });
    return result;
  }
}

export class CliProvider implements AgentProvider {
  readonly name: string;
  readonly configSchema = configSchema;
  readonly capabilities: ProviderCapabilities;
  constructor(readonly id: "codex-cli" | "pi-cli") {
    this.name = id === "codex-cli" ? "Codex CLI" : "Pi CLI";
    this.capabilities = { modelCatalog: true, structuredOutput: "validated", tools: false, nativeResume: false, textStream: id === "pi-cli" };
  }
  async detect(setting: ProviderSetting): Promise<ProviderView["readiness"]> {
    try {
      const executable = this.executable(setting);
      accessSync(executable, constants.X_OK);
      const result = await executeProcess({ executable, args: ["--version"], cwd: tmpdir(), timeoutMs: 10000, maxBytes: 65536 });
      check(result.exitCode === 0, "PROVIDER_UNAVAILABLE", result.stderr || "版本检测失败");
      const config = this.id === "codex-cli" ? readCodexConfig() : undefined;
      return { state: "ready", version: result.stdout.trim().slice(0, 200), reason: config
        ? `CLI 可执行；沿用本机 Codex 配置${config.customRoute ? "（自定义网关）" : ""}${config.catalogPath ? "与自定义模型目录" : ""}；模型权限需验证`
        : "CLI 可执行；账号及模型权限在调用时验证" };
    } catch (error) { return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
  }
  async models(setting: ProviderSetting, cwd: string) {
    try {
      const models: Model[] = [];
      if (this.id === "codex-cli") {
        return readCodexModels();
      } else {
        const result = await executeProcess({ executable: this.executable(setting), args: ["--list-models", "--no-extensions", "--no-mcp"], cwd, timeoutMs: 15000, maxBytes: 512000 });
        check(result.exitCode === 0, "MODEL_CATALOG_FAILED", result.stderr);
        for (const line of result.stdout.replace(/\u001b\[[0-9;]*m/g, "").split("\n")) {
          const [provider, model, context] = line.trim().split(/\s+/);
          if (provider && model && context && /^\d/.test(context) && provider !== "provider") models.push({ id: `${provider}/${model}`, name: `${model} · ${provider}`, source: "discovered" });
        }
      }
      return { models: [...new Map(models.map(m => [m.id, m])).values()], ...(models.length ? {} : { warning: "模型目录为空，可在设置中补充明确的模型 ID" }) };
    } catch (error) { return { models: [], warning: `模型目录读取失败，可手动补充：${error instanceof Error ? error.message : String(error)}` }; }
  }
  async turn(setting: ProviderSetting, request: TurnRequest): Promise<ProviderResult> {
    if (this.id === "codex-cli") readCodexConfig();
    const directory = mkdtempSync(join(request.cwd, ".agent-"));
    let text: string | undefined, modelId = request.modelId, modelSource: "reported" | "requested" = "requested", usage: unknown, reportedError: string | undefined, pending = "";
    const finalFile = join(directory, "result.txt");
    const args = this.id === "codex-cli"
      ? ["exec", "--json", "--ephemeral", "--skip-git-repo-check",
        ...["shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "browser_use", "computer_use", "in_app_browser", "image_generation"].flatMap(feature => ["--disable", feature]),
        "-c", "mcp_servers={}", "-c", "notify=[]", "-c", 'web_search="disabled"', "-s", "read-only", "-m", request.modelId, "-o", finalFile, "-"]
      : ["-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--no-tools", "--thinking", "off", "--model", request.modelId];
    const parseLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }
      if (typeof event.model === "string") { modelId = event.model; modelSource = "reported"; }
      if (event.type === "error" || event.type === "turn.failed") reportedError = JSON.stringify(event).slice(0, 2000);
      if (event.type === "turn.completed") usage = event.usage;
      if (this.id === "pi-cli") {
        const message = event.message as { role?: string; content?: { type: string; text?: string }[]; model?: string; usage?: unknown; stopReason?: string; errorMessage?: string } | undefined;
        if ((event.type === "turn_end" || event.type === "message_end") && message?.role === "assistant") {
          text = (message.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join("");
          modelId = message.model ?? request.modelId; modelSource = message.model ? "reported" : "requested"; usage = message.usage;
          if (message.stopReason === "error" || message.stopReason === "aborted") reportedError = message.errorMessage ?? message.stopReason;
        }
        const delta = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (delta?.type === "text_delta") request.emit({ type: "provider.text", payload: { text: delta.delta } });
      }
    };
    try {
      const schemaPrompt = request.schema === undefined ? "" : `\nReturn only valid JSON matching this JSON Schema:\n${JSON.stringify(request.schema)}`;
      const result = await executeProcess({
        executable: this.executable(setting), args, cwd: directory, input: request.prompt + schemaPrompt,
        signal: request.signal, timeoutMs: request.timeoutMs, maxBytes: 8 * 1024 * 1024,
        onLog: (stream, chunk) => {
          if (stream === "stderr") request.emit({ type: "provider.diagnostic", payload: { text: chunk } });
          else {
            pending += chunk; let index: number;
            while ((index = pending.indexOf("\n")) >= 0) { parseLine(pending.slice(0, index).replace(/\r$/, "")); pending = pending.slice(index + 1); }
          }
        },
      });
      if (pending) parseLine(pending);
      check(result.exitCode === 0 && !reportedError, "PROVIDER_FAILED", reportedError ?? result.stderr.slice(-2000) ?? `CLI exited ${result.exitCode}`);
      if (this.id === "codex-cli") {
        const info = lstatSync(finalFile);
        check(info.isFile() && !info.isSymbolicLink() && info.size <= 8 * 1024 * 1024, "OUTPUT_LIMIT", "Codex 最终消息文件无效或超过 8 MiB");
        text = readFileSync(finalFile, "utf8");
      }
      check(typeof text === "string" && text.length > 0, "INVALID_AGENT_OUTPUT", "CLI 未返回最终消息");
      let output: unknown = text;
      if (request.schema !== undefined) {
        try { output = JSON.parse(text); } catch { throw new AppError("INVALID_AGENT_OUTPUT", `Agent 结果不是合法 JSON: ${text.slice(0, 200)}`); }
        assertSchema(output, request.schema, "Agent 输出");
      }
      return { output, modelId, modelSource, providerId: this.id, ...(usage === undefined ? {} : { usage }) };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  private executable(setting: ProviderSetting) {
    const executable = setting.config.executable;
    check(typeof executable === "string" && isAbsolute(executable), "INVALID_EXECUTABLE", "CLI 路径必须为绝对路径");
    return executable;
  }
}
