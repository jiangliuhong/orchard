import { BrowserChannel, preprocessBrowser } from "./browser-execution.js";
import type { CredentialBindings } from "./credential-inputs.js";
import { executeHttpTool, type HttpDependencies } from "./execution.js";
import { ConfigWriteCoordinator } from "../config-git/coordinator.js";
import { AppError, check } from "../domain/errors.js";
import { catalogHashFor, listTools, validateToolArgs, type WebBridgeApplication, type WebBridgeTool } from "./catalog.js";
import { WebBridgeClient } from "./client.js";
import { WebBridgeConfig } from "./config.js";
import { postprocessResponse } from "./postprocess.js";

export interface WebBridgeStatus { enabled: boolean; connected: boolean; catalogHash: string; extensionVersion: string | null; pending: number; sites: unknown[] }
export interface WebBridgeProfile { id: string; name: string; extensionId: string; connected: boolean; lastSeen: number }
export class WebBridgeGateway {
  readonly browserChannel = new BrowserChannel();
  private closed = false;
  readonly httpDependencies: HttpDependencies = {};
  private httpCalls = new Set<AbortController>();
  private profiles = new Map<string, WebBridgeProfile>();
  constructor(readonly client: WebBridgeClient, readonly config?: WebBridgeConfig, readonly coordinator = config?.coordinator ?? new ConfigWriteCoordinator()) {}
  reloadAfterRestore() {
    this.config?.reloadAfterRestore();
    this.browserChannel.close();
    this.profiles.clear();
    this.client.close();
    this.client.catalogHash = catalogHashFor(this.tools());
  }
  async status(signal?: AbortSignal): Promise<WebBridgeStatus> {
    return this.coordinator.withActivity("WebBridgeGateway.status", async () => {
      if (this.closed) throw new AppError("SERVER_NOT_RUNNING", "Web Bridge 已关闭");
      this.client.catalogHash = catalogHashFor(this.tools());
      const state = await this.client.status();
      signal?.throwIfAborted();
      return { enabled: true, connected: state.connected, catalogHash: this.client.catalogHash, extensionVersion: null, pending: 0, sites: [] };
    });
  }
  applications(): WebBridgeApplication[] { return this.config?.applications() ?? []; }
  tools(application?: string): WebBridgeTool[] { return this.config?.tools(application) ?? listTools(application); }
  saveApplication(application: { id: string; name: string; enabled?: boolean }) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.saveApplication(application); }
  deleteApplication(id: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.deleteApplication(id); }
  saveTool(tool: Parameters<WebBridgeConfig["saveTool"]>[0]) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.saveTool(tool); }
  deleteTool(application: string, toolId: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); check(this.tools(application).some(item => item.toolId === toolId), "UNKNOWN_TOOL", "工具不存在"); this.config.deleteTool(application, toolId); }
  saveEnvironment(application: string, environment: Parameters<WebBridgeConfig["saveEnvironment"]>[1]) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); return this.config.saveEnvironment(application, environment); }
  deleteEnvironment(application: string, id: string) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); this.config.deleteEnvironment(application, id); }
  setToolEnabled(application: string, toolId: string, enabled: boolean) { check(this.config, "CONFIG_UNAVAILABLE", "Web Bridge 配置不可用"); check(this.tools(application).some(tool => tool.toolId === toolId), "UNKNOWN_TOOL", "工具不存在"); this.config.setToolEnabled(application, toolId, enabled); }
  registerProfile(profile: { id: string; name: string; extensionId: string }) {
    return this.coordinator.withWrite(() => {
      check(/^[a-zA-Z0-9._-]{1,100}$/.test(profile.id), "INVALID_PROFILE", "浏览器资料 ID 无效");
      check(profile.name.trim().length > 0 && profile.name.length <= 100, "INVALID_PROFILE", "浏览器资料名称不能为空");
      if (profile.id !== profile.extensionId) {
        const config = this.config;
        for (const application of config?.applications() ?? []) {
          for (const environment of config?.environments(application.id) ?? []) {
            if (environment.profileId === profile.extensionId) config?.saveEnvironment(application.id, { ...environment, profileId: profile.id });
          }
        }
        this.profiles.delete(profile.extensionId);
      }
      const next = { ...profile, name: profile.name.trim(), connected: true, lastSeen: Date.now() };
      this.profiles.set(profile.id, next); return next;
    });
  }
  profilesList() { return [...this.profiles.values()].map(profile => ({ ...profile, connected: Date.now() - profile.lastSeen < 150000 })).sort((a, b) => b.lastSeen - a.lastSeen); }
  async call(application: string, toolId: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number; requestId?: string; environmentId?: string; approved?: boolean; credentialBindings?: CredentialBindings } = {}) {
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
            check(environment.profileId, "PROFILE_REQUIRED", "浏览器环境需要绑定资料");
            const { request, secrets } = await preprocessBrowser(tool.execution, args, tool, signal, this.httpDependencies.resolveCredential, options.credentialBindings);
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

