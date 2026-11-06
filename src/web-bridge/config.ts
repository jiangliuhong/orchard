import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";
import type { WebBridgeApplication } from "./catalog.js";
import type { WebBridgeTool } from "./catalog.js";

export interface WebBridgeEnvironment {
  id: string;
  origin: string;
  profileId?: string;
  extensionId?: string;
  enabled: boolean;
  bound: boolean;
  tabAvailable: boolean;
}
interface ConfigFile {
  applications: Record<string, { id: string; name: string; enabled: boolean }>;
  environments: Record<string, WebBridgeEnvironment[]>;
  tools: Record<string, WebBridgeTool>;
  enabledTools: Record<string, boolean>;
}

export class WebBridgeConfig {
  private readonly path: string;
  private value: ConfigFile;
  constructor(dataDir: string) {
    const directory = join(dataDir, "config");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "web-bridge.json");
    this.value = existsSync(this.path) ? { applications: {}, environments: {}, tools: {}, enabledTools: {}, ...JSON.parse(readFileSync(this.path, "utf8")) as Partial<ConfigFile> } : { applications: {}, environments: {}, tools: {}, enabledTools: {} };
  }
  applications(): WebBridgeApplication[] {
    return Object.values(this.value.applications).map(application => ({ ...application, environments: this.environments(application.id) }));
  }
  application(id: string) { return this.value.applications[id]; }
  saveApplication(application: { id: string; name: string; enabled?: boolean }) {
    check(/^[a-z][a-z0-9-]{0,49}$/.test(application.id), "INVALID_APPLICATION", "应用 ID 必须是小写字母、数字和短横线");
    check(application.name.trim().length > 0 && application.name.length <= 100, "INVALID_APPLICATION", "应用名称不能为空");
    this.value.applications[application.id] = { id: application.id, name: application.name.trim(), enabled: application.enabled ?? true }; this.flush(); return this.value.applications[application.id];
  }
  deleteApplication(id: string) {
    const application = this.value.applications[id];
    check(application, "NOT_FOUND", "应用不存在");
    const environments = this.environments(id).length;
    const tools = Object.keys(this.value.tools).filter(key => key.startsWith(`${id}/`)).length;
    delete this.value.applications[id]; delete this.value.environments[id];
    for (const key of Object.keys(this.value.tools)) if (key.startsWith(`${id}/`)) delete this.value.tools[key];
    for (const key of Object.keys(this.value.enabledTools)) if (key.startsWith(`${id}/`)) delete this.value.enabledTools[key];
    this.flush(); return { applicationId: id, environments, tools };
  }
  environments(application: string) { return this.value.environments[application] ?? []; }
  saveEnvironment(application: string, environment: Partial<WebBridgeEnvironment> & { id?: string }) {
    check(/^[a-z][a-z0-9-]{0,49}$/.test(application), "UNKNOWN_APPLICATION", "应用 ID 无效");
    check((typeof environment.origin === "string" && /^https:\/\/[^/]+$/.test(environment.origin)) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(environment.origin ?? ""), "INVALID_ORIGIN", "环境必须是无路径 HTTPS origin，或本机 HTTP");
    check(this.value.applications[application], "UNKNOWN_APPLICATION", "应用不存在");
    const list = this.environments(application), id = environment.id ?? randomUUID();
    const next = { id, origin: environment.origin!, profileId: environment.profileId?.trim() || undefined, extensionId: environment.extensionId?.trim() || undefined, enabled: environment.enabled ?? true, bound: environment.bound ?? false, tabAvailable: environment.tabAvailable ?? false };
    const index = list.findIndex(item => item.id === id);
    if (index >= 0) list[index] = next; else list.push(next);
    this.value.environments[application] = list; this.flush(); return next;
  }
  deleteEnvironment(application: string, id: string) {
    this.value.environments[application] = this.environments(application).filter(item => item.id !== id); this.flush();
  }
  tools(application?: string) { return Object.values(this.value.tools).filter(tool => !application || tool.application === application).map(tool => ({ ...tool, enabled: this.toolEnabled(tool.application, tool.toolId) })); }
  saveTool(tool: Omit<WebBridgeTool, "enabled"> & { enabled?: boolean }) {
    check(this.value.applications[tool.application], "UNKNOWN_APPLICATION", "应用不存在");
    check(/^[a-z][a-z0-9_-]{0,99}$/.test(tool.toolId), "INVALID_TOOL", "工具 ID 无效");
    check(/^\/[^/]/.test(tool.path), "INVALID_TOOL", "工具路径必须是同源绝对路径");
    check(tool.method === "GET" || tool.method === "POST", "INVALID_TOOL", "只支持 GET 或 POST");
    check(tool.timeoutMs >= 100 && tool.timeoutMs <= 120000, "INVALID_TOOL", "超时必须在 100–120000 毫秒之间");
    const key = `${tool.application}/${tool.toolId}`;
    this.value.tools[key] = { ...tool, enabled: true }; this.flush(); return this.value.tools[key];
  }
  deleteTool(application: string, toolId: string) { delete this.value.tools[`${application}/${toolId}`]; delete this.value.enabledTools[`${application}/${toolId}`]; this.flush(); }
  toolEnabled(application: string, tool: string) { return this.value.enabledTools[`${application}/${tool}`] ?? this.value.tools[`${application}/${tool}`]?.enabled ?? true; }
  setToolEnabled(application: string, tool: string, enabled: boolean) { this.value.enabledTools[`${application}/${tool}`] = enabled; this.flush(); }
  private flush() {
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, this.path);
  }
}
