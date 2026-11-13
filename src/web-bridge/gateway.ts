import { existsSync } from "node:fs";
import { extensionDirectory } from "./catalog.js";
import { nativeHostStatus } from "./install.js";
import { BridgeExecutionHistory } from "./history.js";
import { BrowserChannel, preprocessBrowser } from "./browser-execution.js";
import type { CredentialBindings } from "./credential-inputs.js";
import { executeHttpTool, type HttpDependencies, type CredentialResolver } from "./execution.js";
import { ConfigWriteCoordinator } from "../config-git/coordinator.js";
import { AppError, check } from "../domain/errors.js";
import { catalogHashFor, listTools, validateToolArgs, type WebBridgeApplication, type WebBridgeTool } from "./catalog.js";
import { WebBridgeClient } from "./client.js";
import { WebBridgeConfig } from "./config.js";
import { postprocessResponse } from "./postprocess.js";

export interface WebBridgeStatus { enabled: boolean; connected: boolean; catalogHash: string; extensionVersion: string | null; pending: number; sites: unknown[] }
export interface WebBridgeProfile { id: string; name: string; extensionId: string; extensionVersion?: string; connected: boolean; lastSeen: number }
export class WebBridgeGateway {
  readonly browserChannel = new BrowserChannel();
  history = new BridgeExecutionHistory();
  private closed = false;
  readonly httpDependencies: HttpDependencies = {};
  private httpCalls = new Set<AbortController>();
  private profiles = new Map<string, WebBridgeProfile>();
  constructor(readonly client: WebBridgeClient, readonly config?: WebBridgeConfig, readonly coordinator = config?.coordinator ?? new ConfigWriteCoordinator()) {}
  reloadAfterRestore() {
    this.config?.reloadAfterRestore();
    for (const tool of this.tools()) this.history.restrict(tool);
    this.browserChannel.close();
    this.profiles.clear();
    this.client.close();
    this.client.catalogHash = catalogHashFor(this.tools());
  }
  async status(signal?: AbortSignal): Promise<WebBridgeStatus> {
    return this.coordinator.withActivity("WebBridgeGateway.status", async () => {
      if (this.closed) throw new AppError("SERVER_NOT_RUNNING", "Web Bridge 已关闭");
      this.client.catalogHash = catalogHashFor(this.tools());
      signal?.throwIfAborted();
      const profiles = this.profilesList().filter(profile => profile.connected);
      const sites = (this.config?.applications() ?? []).filter(application => application.enabled).flatMap(application => this.config!.environments(application.id).filter(environment => environment.enabled).map(environment => ({ application: application.id, environmentId: environment.id, origin: environment.origin, profileId: environment.profileId, connected: profiles.some(profile => profile.id === environment.profileId) })));
      return { enabled: true, connected: profiles.length > 0, catalogHash: this.client.catalogHash, extensionVersion: profiles[0]?.extensionVersion ?? null, pending: this.browserChannel.status().pending, sites };
    });
  }
  async doctor() {
    const status = await this.status();
    return { ...status, transport: "http", checks: [
      { id: "node", ok: Number(process.versions.node.split(".")[0]) >= 24, code: "NODE_VERSION", message: `Node.js ${process.versions.node}` },
      { id: "extension-package", ok: existsSync(extensionDirectory()), code: "EXTENSION_PACKAGE", message: "Chrome 扩展文件" },
      { id: "browser", ok: status.connected, code: status.connected ? "BROWSER_CONNECTED" : "BROWSER_NOT_CONNECTED", message: status.connected ? "浏览器资料已连接；调用时仍需检查目标页签及登录态" : "请加载扩展并连接本机服务" },
      { id: "native-host", ...nativeHostStatus(), message: "Native Host 用于发现安装时指定的服务；默认端口也可直接通过 HTTP 连接" },
    ] };
  }
  applications(): WebBridgeApplication[] { return this.config?.applications() ?? []; }
  tools(application?: string): WebBridgeTool[] { return this.config?.tools(application) ?? listTools(application); }
  saveApplication(application: { id: string; name: string; enabled?: boolean }) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.saveApplication(application); }
  deleteApplication(id: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.deleteApplication(id); }
  saveTool(tool: Parameters<WebBridgeConfig["saveTool"]>[0]) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); const saved = this.config.saveTool(tool); this.history.restrict(saved); return saved; }
  deleteTool(application: string, toolId: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); check(this.tools(application).some(item => item.toolId === toolId), "UNKNOWN_TOOL", "工具不存在"); this.config.deleteTool(application, toolId); }
  saveEnvironment(application: string, environment: Parameters<WebBridgeConfig["saveEnvironment"]>[1]) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.saveEnvironment(application, environment); }
  deleteEnvironment(application: string, id: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); this.config.deleteEnvironment(application, id); }
  setToolEnabled(application: string, toolId: string, enabled: boolean) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); check(this.tools(application).some(tool => tool.toolId === toolId), "UNKNOWN_TOOL", "工具不存在"); this.config.setToolEnabled(application, toolId, enabled); }
  registerProfile(profile: { id: string; name: string; extensionId: string; extensionVersion?: string }) {
    check(/^[a-zA-Z0-9._-]{1,100}$/.test(profile.id), "INVALID_PROFILE", "浏览器资料 ID 无效");
    check(profile.name.trim().length > 0 && profile.name.length <= 100, "INVALID_PROFILE", "浏览器资料名称不能为空");
    if (profile.id !== profile.extensionId) {
      const config = this.config;
      const bindings = (config?.applications() ?? []).flatMap(application =>
        (config?.environments(application.id) ?? []).filter(environment => environment.profileId === profile.extensionId)
          .map(environment => ({ application: application.id, environment })));
      // Heartbeats/connection state are not configuration writes. Only an actual
      // automatic binding migration takes the business gate (before Map changes).
      if (bindings.length) this.coordinator.withWrite(() => {
        for (const { application, environment } of bindings) config!.saveEnvironment(application, { ...environment, profileId: profile.id });
      });
      this.profiles.delete(profile.extensionId);
    }
    const next = { ...profile, name: profile.name.trim(), connected: true, lastSeen: Date.now() };
    this.profiles.set(profile.id, next); return next;
  }
  profilesList() { return [...this.profiles.values()].map(profile => ({ ...profile, connected: Date.now() - profile.lastSeen < 150000 })).sort((a, b) => b.lastSeen - a.lastSeen); }
  async call(application: string, toolId: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number; requestId?: string; environmentId?: string; approved?: boolean; credentialBindings?: CredentialBindings; resolveCredential?: CredentialResolver; source?: "call" | "test"; omitHistoryArgs?: boolean } = {}) {
    const startedAt = Date.now();
    // Caller privacy policy can only tighten the tool’s own history policy.
    const omitHistoryArgs = options.omitHistoryArgs === true;
    const capturedArgs = omitHistoryArgs ? null : JSON.parse(JSON.stringify(args ?? null));
    const capturedTool = structuredClone(this.tools(application).find(item => item.toolId === toolId));
    const capturedBindings = structuredClone(options.credentialBindings);
    const environments = this.config?.environments(application).filter(item => item.enabled) ?? [];
    const environmentId = options.environmentId ?? (environments.length === 1 ? environments[0].id : undefined);
    let status: "succeeded" | "failed" = "failed", errorCode: string | undefined;
    try {
      const result = await this.execute(application, toolId, args, options);
      status = "succeeded";
      return result;
    } catch (error) {
      errorCode = error instanceof AppError ? error.code : "EXECUTION_FAILED";
      throw error;
    } finally {
      try {
        this.history.add({ application, toolId, args: capturedArgs, source: options.source ?? "call", startedAt, durationMs: Date.now() - startedAt, status, environmentId, errorCode }, { tool: capturedTool, bindings: capturedBindings, omitArgs: omitHistoryArgs });
        const currentTool = this.tools(application).find(item => item.toolId === toolId);
        if (currentTool) this.history.restrict(currentTool);
      } catch {
        // Never turn a completed business action into a failure that encourages duplicate execution.
        console.warn("Web Bridge 执行历史保存失败，请检查本地存储空间与权限");
      }
    }
  }
  private async execute(application: string, toolId: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number; requestId?: string; environmentId?: string; approved?: boolean; credentialBindings?: CredentialBindings; resolveCredential?: CredentialResolver }) {
    return this.coordinator.withActivity("WebBridgeGateway.call", async () => {
      const tool = this.tools(application).find(item => item.toolId === toolId);
      check(tool, "UNKNOWN_TOOL", `未知浏览器工具: ${application}/${toolId}`);
      check(this.config?.application(application)?.enabled ?? true, "PERMISSION_DENIED", "应用已停用");
      check(this.config?.toolEnabled(application, toolId) ?? tool.enabled, "PERMISSION_DENIED", "工具已停用");
      check((tool.risk === "read" && tool.approval === "none") || options.approved === true, "APPROVAL_REQUIRED", "该工具需要用户确认");
      check(!options.credentialBindings || tool.execution?.transport === "browser", "INVALID_CREDENTIALS", "调用凭据仅适用于 browser 执行模式");
      validateToolArgs(tool, args);
      check(!this.closed, "SERVER_NOT_RUNNING", "Web Bridge 已关闭");
      options.signal?.throwIfAborted();
      const timeoutMs = Math.min(options.timeoutMs ?? tool.timeoutMs, tool.timeoutMs);
      if (tool.execution) {
        const environments = this.config?.environments(application).filter(environment => environment.enabled && (!options.environmentId || environment.id === options.environmentId)) ?? [];
        check(environments.length === 1, "ENVIRONMENT_REQUIRED", "请选择唯一的已启用运行环境");
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        this.httpCalls.add(controller);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
        try {
          if (tool.execution.transport === "browser") {
            const environment = environments[0];
            check(environment.profileId, "PROFILE_REQUIRED", `环境 ${environment.key ?? environment.id} 尚未绑定本机浏览器，请前往 Web Bridge 环境设置选择浏览器资料`);
            const resolveCredential: CredentialResolver = (dictionaryId, key) => {
              const explicit = Object.values(options.credentialBindings ?? {}).some(binding => binding.source === "dictionary" && binding.dictionaryId === dictionaryId && binding.key === key);
              const resolve = explicit && options.resolveCredential ? options.resolveCredential : this.httpDependencies.resolveCredential;
              check(resolve, "CREDENTIAL_UNAVAILABLE", "服务未配置安全凭据解析器");
              return resolve(dictionaryId, key);
            };
            const { request, secrets } = await preprocessBrowser(tool.execution, args, tool, signal, resolveCredential, options.credentialBindings);
            const result = await this.browserChannel.call(environment.profileId, { origin: environment.origin, request, maxBytes: tool.execution.response.maxBytes, timeoutMs: Math.max(1, deadline - Date.now()), deadline }, signal);
            const serialized = JSON.stringify(result);
            check(serialized !== undefined && Buffer.byteLength(serialized) <= tool.execution.response.maxBytes, "RESPONSE_TOO_LARGE", "响应超过限制");
            check(!secrets.filter(Boolean).some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))), "SENSITIVE_RESPONSE", "响应包含鉴权信息，已阻止返回");
            if (tool.execution.response.mode === "fullJson" || result === null) return await postprocessResponse(tool.execution.postprocess, result, args, signal, tool.execution.response.maxBytes, secrets);
            check(result !== null && typeof result === "object" && !Array.isArray(result), "INVALID_RESPONSE", "字段白名单要求对象响应");
            const selected = Object.fromEntries(tool.fields.filter(field => Object.hasOwn(result, field)).map(field => [field, (result as Record<string, unknown>)[field]]));
            return await postprocessResponse(tool.execution.postprocess, selected, args, signal, tool.execution.response.maxBytes, secrets);
          }
          return await executeHttpTool({ ...tool, execution: tool.execution }, environments[0].origin, args as Record<string, unknown>, signal, this.httpDependencies);
        } finally { this.httpCalls.delete(controller); }
      }
      this.client.catalogHash = catalogHashFor(this.tools());
      return this.client.call(tool.toolId, args, { ...options, timeoutMs });
    });
  }
  close() { this.browserChannel.close(); this.closed = true; for (const controller of this.httpCalls) controller.abort(); this.client.close(); }
}

