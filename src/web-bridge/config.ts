import { ConfigWriteCoordinator } from "../config-git/coordinator.js";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";
import type { WebBridgeApplication } from "./catalog.js";
import type { WebBridgeTool } from "./catalog.js";
import { validateBridgeConfigV1 } from "./config-validation.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { prepareBridgeProposal } from "./authoring.js";
import { validateStoredHttpTool } from "./execution.js";

function validateExecutions(value: ConfigFile) {
  for (const tool of Object.values(value.tools)) validateStoredHttpTool(tool);
}

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
  schemaVersion: 1;
  [key: string]: unknown;
  applications: Record<string, { id: string; name: string; enabled: boolean }>;
  environments: Record<string, WebBridgeEnvironment[]>;
  tools: Record<string, WebBridgeTool>;
  enabledTools: Record<string, boolean>;
}

export class WebBridgeConfig {
  private readonly path: string;
  private value: ConfigFile;
  constructor(dataDir: string, readonly coordinator = new ConfigWriteCoordinator()) {
    const directory = join(dataDir, "config");
    this.path = join(directory, "web-bridge.json");
    this.value = validateBridgeConfigV1(readFileSync(this.path, "utf8")) as unknown as ConfigFile;
    validateExecutions(this.value);
  }
  /** Called inside the restore barrier after the configuration file is installed. */
  reloadAfterRestore() {
    const value = validateBridgeConfigV1(readFileSync(this.path, "utf8")) as unknown as ConfigFile;
    validateExecutions(value);
    for (const environments of Object.values(value.environments)) for (const environment of environments) {
      environment.bound = false;
      environment.tabAvailable = false;
    }
    this.value = value;
  }
  applications(): WebBridgeApplication[] {
    return Object.values(this.value.applications).map(application => ({ ...application, environments: this.environments(application.id) }));
  }
  application(id: string) { return this.value.applications[id]; }
  saveApplication(application: { id: string; name: string; enabled?: boolean }) {
    return this.coordinator.withWrite(() => {
      check(/^[a-z][a-z0-9-]{0,49}$/.test(application.id), "INVALID_APPLICATION", "应用 ID 必须是小写字母、数字和短横线");
      check(application.name.trim().length > 0 && application.name.length <= 100, "INVALID_APPLICATION", "应用名称不能为空");
      this.value.applications[application.id] = { ...this.value.applications[application.id], id: application.id, name: application.name.trim(), enabled: application.enabled ?? true }; this.flush(); return this.value.applications[application.id];
    });
  }
  deleteApplication(id: string) {
    return this.coordinator.withWrite(() => {
      const application = this.value.applications[id];
      check(application, "NOT_FOUND", "应用不存在");
      const environments = this.environments(id).length;
      const tools = Object.keys(this.value.tools).filter(key => key.startsWith(`${id}/`)).length;
      delete this.value.applications[id]; delete this.value.environments[id];
      for (const key of Object.keys(this.value.tools)) if (key.startsWith(`${id}/`)) delete this.value.tools[key];
      for (const key of Object.keys(this.value.enabledTools)) if (key.startsWith(`${id}/`)) delete this.value.enabledTools[key];
      this.flush(); return { applicationId: id, environments, tools };
    });
  }
  environments(application: string) { return this.value.environments[application] ?? []; }
  saveEnvironment(application: string, environment: Partial<WebBridgeEnvironment> & { id?: string }) {
    return this.coordinator.withWrite(() => {
      check(/^[a-z][a-z0-9-]{0,49}$/.test(application), "UNKNOWN_APPLICATION", "应用 ID 无效");
      check((typeof environment.origin === "string" && /^https:\/\/[^/]+$/.test(environment.origin)) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(environment.origin ?? ""), "INVALID_ORIGIN", "环境必须是无路径 HTTPS origin，或本机 HTTP");
      check(this.value.applications[application], "UNKNOWN_APPLICATION", "应用不存在");
      const list = this.environments(application), id = environment.id ?? randomUUID();
      const next = { ...list.find(item => item.id === id), id, origin: environment.origin!, profileId: environment.profileId?.trim() || undefined, extensionId: environment.extensionId?.trim() || undefined, enabled: environment.enabled ?? true, bound: environment.bound ?? false, tabAvailable: environment.tabAvailable ?? false };
      const index = list.findIndex(item => item.id === id);
      if (index >= 0) list[index] = next; else list.push(next);
      this.value.environments[application] = list; this.flush(); return next;
    });
  }
  deleteEnvironment(application: string, id: string) {
    return this.coordinator.withWrite(() => {
      this.value.environments[application] = this.environments(application).filter(item => item.id !== id); this.flush();
    });
  }
  tools(application?: string) { return Object.values(this.value.tools).filter(tool => !application || tool.application === application).map(tool => ({ ...tool, enabled: this.toolEnabled(tool.application, tool.toolId) })); }
  authoringSnapshot(application: string) {
    check(this.application(application), "NOT_FOUND", "应用不存在", 404);
    const snapshot = structuredClone({ application: this.application(application)!, environments: this.environments(application), tools: this.tools(application) });
    return { ...snapshot, hash: digest(canonicalJson(snapshot)) };
  }
  applyProposal(application: string, expectedHash: string, proposal: unknown) {
    return this.coordinator.withWrite(() => {
      const snapshot = this.authoringSnapshot(application);
      check(snapshot.hash === expectedHash, "REVISION_CONFLICT", "应用配置已变化，请重新生成变更", 409);
      const prepared = prepareBridgeProposal(application, snapshot.tools, proposal);
      check(prepared.proposal.changes.length, "NO_CHANGES", "此回复没有需要应用的变更");
      const next = structuredClone(this.value);
      for (const change of prepared.proposal.changes) {
        const key = `${application}/${change.toolId}`;
        if (change.operation === "delete") { delete next.tools[key]; delete next.enabledTools[key]; }
        else { next.tools[key] = change.definition!; next.enabledTools[key] = change.definition!.enabled; }
      }
      validateBridgeConfigV1(JSON.stringify(next));
      const previous = this.value;
      this.value = next;
      try { this.flush(); } catch (error) { this.value = previous; throw error; }
      return this.authoringSnapshot(application);
    });
  }
  saveTool(tool: Omit<WebBridgeTool, "enabled"> & { enabled?: boolean }) {
    return this.coordinator.withWrite(() => {
      const snapshot = this.authoringSnapshot(tool.application);
      const key = `${tool.application}/${tool.toolId}`;
      // This API saves a complete definition: omitted optional execution resets to legacy mode.
      const definition = { ...tool, enabled: tool.enabled ?? this.toolEnabled(tool.application, tool.toolId) };
      this.applyProposal(tool.application, snapshot.hash, { summary: "保存工具定义", changes: [{ operation: this.value.tools[key] ? "update" : "create", toolId: tool.toolId, definition }] });
      return definition;
    });
  }
  deleteTool(application: string, toolId: string) {
    return this.coordinator.withWrite(() => { delete this.value.tools[`${application}/${toolId}`]; delete this.value.enabledTools[`${application}/${toolId}`]; this.flush();
    });
  }
  toolEnabled(application: string, tool: string) { return this.value.enabledTools[`${application}/${tool}`] ?? this.value.tools[`${application}/${tool}`]?.enabled ?? true; }
  setToolEnabled(application: string, tool: string, enabled: boolean) {
    return this.coordinator.withWrite(() => { this.value.enabledTools[`${application}/${tool}`] = enabled; this.flush();
    });
  }
  private flush() {
    validateBridgeConfigV1(JSON.stringify(this.value));
    const temp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temp, JSON.stringify(this.value, null, 2), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, this.path);
  }
}
