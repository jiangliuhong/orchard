import { AppError, check } from "../domain/errors.js";
import { catalogHashFor, listTools, validateToolArgs, type WebBridgeApplication, type WebBridgeTool } from "./catalog.js";
import { WebBridgeClient } from "./client.js";
import { WebBridgeConfig } from "./config.js";

export interface WebBridgeStatus { enabled: boolean; connected: boolean; catalogHash: string; extensionVersion: string | null; pending: number; sites: unknown[] }
export interface WebBridgeProfile { id: string; name: string; extensionId: string; connected: boolean; lastSeen: number }
export class WebBridgeGateway {
  private closed = false;
  private profiles = new Map<string, WebBridgeProfile>();
  constructor(readonly client: WebBridgeClient, readonly config?: WebBridgeConfig) {}
  async status(signal?: AbortSignal): Promise<WebBridgeStatus> {
    if (this.closed) throw new AppError("SERVER_NOT_RUNNING", "Web Bridge 已关闭");
    this.client.catalogHash = catalogHashFor(this.tools());
    const state = await this.client.status();
    signal?.throwIfAborted();
    return { enabled: true, connected: state.connected, catalogHash: this.client.catalogHash, extensionVersion: null, pending: 0, sites: [] };
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
  }
  profilesList() { return [...this.profiles.values()].map(profile => ({ ...profile, connected: Date.now() - profile.lastSeen < 150000 })).sort((a, b) => b.lastSeen - a.lastSeen); }
  async call(application: string, toolId: string, args: unknown, options: { signal?: AbortSignal; timeoutMs?: number; requestId?: string } = {}) {
    const tool = this.tools(application).find(item => item.toolId === toolId);
    check(tool, "UNKNOWN_TOOL", `未知浏览器工具: ${application}/${toolId}`);
    check(this.config?.toolEnabled(application, toolId) ?? tool.enabled, "PERMISSION_DENIED", "工具已停用");
    check(tool.risk === "read" && tool.approval === "none", "APPROVAL_REQUIRED", "该工具需要用户确认");
    validateToolArgs(tool, args);
    const timeoutMs = Math.min(options.timeoutMs ?? tool.timeoutMs, tool.timeoutMs);
    this.client.catalogHash = catalogHashFor(this.tools());
    return this.client.call(tool.toolId, args, { ...options, timeoutMs });
  }
  close() { this.closed = true; this.client.close(); }
}

