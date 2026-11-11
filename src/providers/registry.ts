import { configCoordinator } from "../config-git/coordinator.js";
import { accessSync, constants, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { executeProcess } from "../runtime/process.js";
import { check, AppError, failure } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { AgentChoice, BackendRef, JsonSchema, Model, ModelVerification, ProviderCapabilities, ProviderSetting, ProviderView } from "../domain/types.js";
import { AgentModelConfigs } from "../authoring/agent-model-configs.js";
import type { Store } from "../persistence/store.js";
import { isModelEnabled, visibleModels } from "../domain/models.js";
import { readCodexConfig, readCodexModels } from "./codex-config.js";
import { DEFAULT_AGENT_LIMITS } from "./agent-limits.js";
import type { ExecutionContext, NativeAdapter, SessionProvider } from "./session.js";
import { connectionFingerprint } from "./session.js";
import type { SessionManager } from "./session-manager.js";

export type { BackendRef };

export interface ProviderEvent { type: string; payload: unknown }
export interface TurnRequest {
  executionContext?: ExecutionContext;
  /** 项目临时会话资料目录，不能放入源码快照。 */
  sessionDirectory?: string;
  modelId: string; prompt: string; schema?: JsonSchema; signal: AbortSignal; cwd: string; timeoutMs?: number;
  emit: (event: ProviderEvent) => void;
}
export interface ProviderResult {
  toolCallCount?: number;
  output: unknown; modelId: string; modelSource?: "reported" | "requested"; providerId: string;
  usage?: unknown; usageScope?: "turn" | "session"; backendTurnId?: string;
}
export interface AgentProvider {
  id: string; name: string; capabilities: ProviderCapabilities; configSchema: JsonSchema;
  defaultConfig?: Record<string, unknown>;
  detect(setting: ProviderSetting): Promise<ProviderView["readiness"]>;
  resetCache?(): void;
  models(setting: ProviderSetting, cwd: string): Promise<{ models: Model[]; warning?: string }>;
  /** 可选原生会话能力；按能力分派，业务层不得根据固定 Provider ID 判断会话能力。 */
  sessionProvider?: SessionProvider;
  /** 按配置计算实际能力（如 transport 决定原生会话）；未实现时回退静态声明。 */
  capabilitiesFor?(setting: ProviderSetting): ProviderCapabilities;
}

export function transportOf(config: Record<string, unknown>): "native" {
  check(config.transport === undefined || config.transport === "native", "PROTOCOL_UNSUPPORTED", "仅支持原生会话协议，请检查 Provider 配置");
  return "native";
}
const configSchema: JsonSchema = { type: "object", required: ["executable"], properties: { executable: { type: "string", minLength: 1 }, transport: { const: "native" } }, additionalProperties: false };
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
  readonly modelConfigs: AgentModelConfigs;
  constructor(readonly store: Store) { this.modelConfigs = new AgentModelConfigs(store, this); }
  /** Restore holds the exclusive barrier, so no probe or verification can repopulate stale state. */
  reloadAfterRestore() {
    this.states.clear();
    for (const adapter of this.adapters.values()) adapter.resetCache?.();
  }
  register(provider: AgentProvider, executable = discoveredExecutable(provider.id.replace("-cli", ""))) {
    return configCoordinator(this.store).withWrite(() => {
      check(!this.adapters.has(provider.id), "DUPLICATE_PROVIDER", "Provider ID 已注册");
      this.adapters.set(provider.id, provider);
      if (!this.store.provider(provider.id)) this.store.saveProvider({ id: provider.id, enabled: false, config: provider.defaultConfig ?? { executable, ...(provider instanceof CliProvider ? { transport: "native" } : {}) }, models: [], defaultModel: "", revision: 1, updatedAt: Date.now() });
      return this;
    });
  }
  adapter(id: string) { const adapter = this.adapters.get(id); check(adapter, "PROVIDER_NOT_FOUND", `Provider 未注册: ${id}`); return adapter; }
  views(): ProviderView[] { return [...this.adapters.values()].map(p => {
    const setting = this.store.provider(p.id)!;
    const capabilities = p.capabilitiesFor?.(setting) ?? p.capabilities;
    return { ...setting, models: visibleModels(setting.models), name: p.name, configSchema: p.configSchema, capabilities: { ...capabilities, sessions: capabilities.sessions ?? "none" }, readiness: this.states.get(p.id) ?? { state: "unknown" } };
  }); }
  setting(id: string) { this.adapter(id); return this.store.provider(id)!; }
  update(id: string, input: unknown) {
    return configCoordinator(this.store).withWrite(() => {
      const adapter = this.adapter(id);
      // 输入的 config 允许部分字段（随后与现有配置合并），合并后仍按完整 Schema 校验。
      const configInputSchema: JsonSchema = adapter.configSchema && typeof adapter.configSchema === "object" && !Array.isArray(adapter.configSchema)
        ? { type: "object", properties: (adapter.configSchema as { properties?: Record<string, unknown> }).properties ?? {}, additionalProperties: false }
        : adapter.configSchema;
      assertSchema(input, {
        type: "object", properties: { enabled: { type: "boolean" }, config: configInputSchema, defaultModel: { type: "string", maxLength: 200 },
          models: { type: "array", maxItems: 500, items: { type: "object", required: ["id", "name", "source"], properties: { id: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", minLength: 1, maxLength: 200 }, source: { enum: ["configured", "discovered"] }, enabled: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false,
      }, "Provider 设置");
      const current = this.setting(id), data = input as Partial<ProviderSetting>;
      // 设置保存必须合并现有 config，不能因 UI 只提交 executable 就意外清空 transport（§18.3）。
      const next = { ...current, ...data, config: { ...current.config, ...(data.config ?? {}) }, id, revision: current.revision + 1, updatedAt: Date.now() };
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
    });
  }
  async detect(id: string) {
    return configCoordinator(this.store).withActivity("ProviderRegistry.detect", async () => {
      const setting = this.setting(id), state = await this.adapter(id).detect(setting);
      if (this.setting(id).revision === setting.revision) this.states.set(id, state);
      return state;
    });
  }
  async models(id: string) {
    return configCoordinator(this.store).withActivity("ProviderRegistry.models", async () => {
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
    });
  }
  modelList(id: string) { return visibleModels(this.setting(id).models); }
  get activeVerificationCount() { return this.verifications.size; }
  async verifyModel(id: string, modelId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ModelVerification> {
    return configCoordinator(this.store).withActivity("ProviderRegistry.verifyModel", async () => {
      const setting = this.setting(id), adapter = this.adapter(id);
      check(setting.enabled, "PROVIDER_DISABLED", "请先启用 Provider，再验证模型");
      check(modelId.trim().length > 0 && modelId.length <= 200 && !/^\s*-|[\0\r\n]/.test(modelId), "INVALID_MODEL", "模型 ID 无效");
      const model = setting.models.find(candidate => candidate.id === modelId && !candidate.deleted);
      if (!model) throw new AppError("MODEL_NOT_FOUND", "模型不存在", 404);
      check(!this.verifications.has(id), "MODEL_VERIFICATION_BUSY", "该 Provider 已有模型正在验证，请等待或取消后重试");
      const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_AGENT_LIMITS.modelVerificationTotalTimeoutMs, DEFAULT_AGENT_LIMITS.modelVerificationTotalTimeoutMs);
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
        const response = await this.dispatch(setting, {
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
    });
  }
  async closeVerifications() {
    const active = [...this.verifications.values()];
    for (const verification of active) verification.controller.abort(new AppError("CANCELLED", "服务关闭，模型验证已取消"));
    await Promise.all(active.map(verification => verification.finished));
  }
  addModel(id: string, input: unknown) {
    return configCoordinator(this.store).withWrite(() => {
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
    });
  }
  updateModel(id: string, modelId: string, input: unknown) {
    return configCoordinator(this.store).withWrite(() => {
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
    });
  }
  deleteModel(id: string, modelId: string) {
    return configCoordinator(this.store).withWrite(() => {
      const setting = this.setting(id), model = setting.models.find(candidate => candidate.id === modelId);
      if (!model) throw new AppError("MODEL_NOT_FOUND", "模型不存在", 404);
      if (model.deleted) return this.views().find(provider => provider.id === id)!;
      return this.saveModels(setting, setting.models.map(candidate => candidate.id === modelId ? { ...candidate, enabled: false, deleted: true } : candidate));
    });
  }
  private saveModels(setting: ProviderSetting, models: Model[]): ProviderView {
    return configCoordinator(this.store).withWrite(() => {
      check(visibleModels(models).length <= 500, "MODEL_LIMIT", "每个 Provider 最多保留 500 个模型");
      const defaultEntry = models.find(model => model.id === setting.defaultModel);
      this.store.saveProvider({
        ...setting, models, defaultModel: defaultEntry && !isModelEnabled(defaultEntry) ? "" : setting.defaultModel,
        revision: setting.revision + 1, updatedAt: Date.now(),
      });
      return this.views().find(provider => provider.id === setting.id)!;
    });
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
    return configCoordinator(this.store).withActivity("ProviderRegistry.ready", async () => {
      const effective = this.resolve(choice, defaults), setting = this.setting(effective.providerId);
      const state = await this.adapter(effective.providerId).detect(setting);
      check(this.setting(effective.providerId).enabled, "PROVIDER_DISABLED", "Provider 已禁用");
      check(this.setting(effective.providerId).revision === setting.revision, "SETTINGS_CONFLICT", "Provider 配置已改变，请重试");
      this.states.set(setting.id, state);
      check(state.state === "ready", "PROVIDER_UNAVAILABLE", state.reason ?? "Provider 未就绪", 503);
      return { ...effective, setting };
    });
  }
  async run(choice: AgentChoice, request: Omit<TurnRequest, "modelId">) {
    return configCoordinator(this.store).withActivity("ProviderRegistry.run", async () => {
      const effective = await this.ready(choice);
      request.signal.throwIfAborted();
      request.emit({ type: "provider.started", payload: { providerId: effective.providerId, requestedModel: effective.modelId, revision: effective.setting.revision, executable: effective.setting.config.executable, transport: transportOf(effective.setting.config) } });
      const result = await this.dispatch(effective.setting, { ...request, modelId: effective.modelId });
      request.signal.throwIfAborted();
      if (request.schema !== undefined) assertSchema(result.output, request.schema, "Agent 输出");
      request.emit({ type: "provider.completed", payload: result });
      return result;
    });
  }
  private async dispatch(setting: ProviderSetting, request: TurnRequest): Promise<ProviderResult> {
    return this.withSingleSession(setting, request, session =>
      session.send(request, randomUUID(), async () => {}));
  }

  /** Shared native single-session path for existing callers and the unified Runtime. */
  async withSingleSession<T>(
    setting: ProviderSetting,
    request: Omit<TurnRequest, "prompt" | "emit">,
    action: (session: {
      generation: number;
      send(request: TurnRequest, turnId: string, accepted: () => Promise<void>): Promise<ProviderResult>;
      close(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const adapter = this.adapter(setting.id);
    const sessionProvider = adapter.sessionProvider;
    transportOf(setting.config);
    check(sessionProvider, "PROTOCOL_UNSUPPORTED", "Provider 不支持原生会话协议");
    const project = request.executionContext === "project";
    const capabilities = adapter.capabilitiesFor?.(setting) ?? adapter.capabilities;
    check(!project || capabilities.projectAnalysis === true, "PROJECT_CAPABILITY_UNSUPPORTED", "Provider 尚不支持项目分析");
    const directory = project ? request.cwd : mkdtempSync(join(request.cwd, ".agent-"));
    try {
      const handle = await sessionProvider.openSession(setting, {
        key: `single:${randomUUID()}`, modelId: request.modelId, cwd: directory,
        persistent: false, signal: request.signal, executionContext: request.executionContext, sessionDirectory: request.sessionDirectory,
      });
      let release: Promise<void> | undefined;
      const close = () => release ??= sessionProvider.releaseSession(handle);
      try {
        return await action({
          generation: handle.generation,
          send: (turn, hostTurnId, onAccepted) => {
            check(!release, "INVALID_STATE", "原生会话已关闭", 409);
            return sessionProvider.sendTurn(handle, { ...turn, cwd: directory, hostTurnId, onAccepted });
          },
          close,
        });
      } finally { await close(); }
    } finally {
      // 项目快照由项目 lease 生命周期管理，Registry 不删除调用者目录。
      if (!project) rmSync(directory, { recursive: true, force: true });
    }
  }
}

export class CliProvider implements AgentProvider {
  readonly name: string;
  readonly configSchema = configSchema;
  readonly capabilities: ProviderCapabilities;
  private readonly probeCache = new Map<string, { at: number; readiness: ProviderView["readiness"] }>();
  resetCache() { this.probeCache.clear(); }
  constructor(readonly id: "codex-cli" | "pi-cli", private readonly options: { native: NativeAdapter; probeCacheMs?: number; initializeTimeoutMs?: number; scheduler?: SessionManager }) {
    this.name = id === "codex-cli" ? "Codex CLI" : "Pi CLI";
    this.capabilities = { modelCatalog: true, structuredOutput: "validated", tools: false, nativeResume: false, textStream: id === "pi-cli", sessions: "none" };
  }
  capabilitiesFor(setting: ProviderSetting): ProviderCapabilities {
    transportOf(setting.config);
    return this.options.native.capabilities(setting);
  }
  get sessionProvider(): SessionProvider { return this.options.native.sessionProvider; }
  async detect(setting: ProviderSetting): Promise<ProviderView["readiness"]> {
    try {
      const executable = this.executable(setting);
      accessSync(executable, constants.X_OK);
      // --version 检测同样占用调度槽位（若提供调度器），但不占用后续执行槽（串行释放，§23.1）。
      const versionCheck = async () => executeProcess({ executable, args: ["--version"], cwd: tmpdir(), timeoutMs: 10000, maxBytes: 65536 });
      const result = this.options.scheduler
        ? await this.options.scheduler.acquire(null, new AbortController().signal, `${this.id}-version`).then(async slot => {
          try { return await versionCheck(); } finally { slot.finish(); }
        })
        : await versionCheck();
      check(result.exitCode === 0, "PROVIDER_UNAVAILABLE", result.stderr || "版本检测失败");
      const config = this.id === "codex-cli" ? readCodexConfig() : undefined;
      const base: ProviderView["readiness"] = { state: "ready", version: result.stdout.trim().slice(0, 200), reason: config
        ? `CLI 可执行；沿用本机 Codex 配置${config.customRoute ? "（自定义网关）" : ""}${config.catalogPath ? "与自定义模型目录" : ""}；模型权限需验证`
        : "CLI 可执行；账号及模型权限在调用时验证" };
      transportOf(setting.config);
      return this.probeNative(setting, base);
    } catch (error) { return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
  }
  /** 原生模式无模型协议探测；按连接指纹缓存，配置变化立即失效（新指纹未命中）。 */
  private async probeNative(setting: ProviderSetting, base: ProviderView["readiness"]): Promise<ProviderView["readiness"]> {
    const cacheMs = this.options.probeCacheMs ?? DEFAULT_AGENT_LIMITS.probeCacheMs;
    const fingerprint = connectionFingerprint(setting);
    const cached = this.probeCache.get(fingerprint);
    if (cached && Date.now() - cached.at < cacheMs) return cached.readiness;
    let readiness: ProviderView["readiness"];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "原生模式探测超时")), this.options.initializeTimeoutMs ?? DEFAULT_AGENT_LIMITS.initializeTimeoutMs);
      timer.unref();
      try { await this.options.native.probe(setting, controller.signal); } finally { clearTimeout(timer); }
      // 能力与 readiness 不可混淆：探测通过仅表示协议可用，不等于账号或模型可用性。
      readiness = { ...base, transport: "native" };
    } catch (error) {
      const detail = error instanceof AppError ? error : new AppError("PROTOCOL_UNSUPPORTED", error instanceof Error ? error.message : String(error), 503);
      readiness = { state: "unavailable", transport: "native", errorCode: detail.code, version: base.version, reason: `原生模式探测失败：${detail.message}；请检查 CLI 版本和连接配置` };
    }
    this.probeCache.set(fingerprint, { at: Date.now(), readiness });
    return readiness;
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
  private executable(setting: ProviderSetting) {
    const executable = setting.config.executable;
    check(typeof executable === "string" && isAbsolute(executable), "INVALID_EXECUTABLE", "CLI 路径必须为绝对路径");
    return executable;
  }
}
