import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Store as BusinessStore } from "../src/persistence/store.js";
import { DirectoryLease } from "../src/migrations/lock.js";
import { initializeData, execute, baseline } from "../src/migrations/runner.js";
import { plan } from "../src/migrations/planner.js";
import { present, safe, writeJson, readJson } from "../src/migrations/journal.js";
import type { Job } from "../src/migrations/types.js";
export class TestStore extends BusinessStore {
  private lease: DirectoryLease;
  readonly migrationBackupPath?: string;
  constructor(root: string) {
    const lease = DirectoryLease.acquire(root);
    let migrationBackupPath: string | undefined;
    try {
      if (!present(safe(root, "workbench.db")) && lease.original.length === 0) initializeData(root, "new_install", randomUUID());
      baseline(root);
      const current = plan(root);
      if (current.steps.length) {
        const now = new Date().toISOString(), id = randomUUID(), ledger = safe(root, "migrations/ledger.json");
        const job: Job = { formatVersion: 1, jobId: id, requestId: id, requestScope: "test-explicit-migration", inputHmac: "test", plan: current, phase: "accepted", revision: 1, startedAt: now, updatedAt: now, steps: current.steps.map(s => ({id:s.id,state:"pending"})), processed: 0, install: [], ledgerBefore: present(ledger) ? readJson(ledger) : null };
        writeJson(safe(root, `migrations/jobs/${id}/state.json`), job);
        const result = execute(root, job); if (result.phase !== "committed") throw new Error(result.error?.code ?? result.phase);
        migrationBackupPath = safe(root, `backups/migrations/${id}/snapshot/workbench.db`);
      } else if (current.sourceVersions.webBridge === null) initializeData(root, "optional_config", randomUUID());
      baseline(root);
      super(root, lease); this.lease = lease; this.migrationBackupPath = migrationBackupPath; this.recoverBusiness();
    } catch (error) { lease.release(); throw error; }
  }
  override close() { super.close(); if (present(safe(this.root, "workbench.lock"))) this.lease.release(); }
}
import { ProviderRegistry, type AgentProvider, type TurnRequest, type ProviderResult } from "../src/providers/registry.js";
import { AuthoringService } from "../src/authoring/service.js";
import type { SessionProvider, ProviderSessionHandle, SessionOpenRequest, SessionTurnRequest } from "../src/providers/session.js";
import type { SourceFiles, Workflow } from "../src/domain/types.js";

export function temporary(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "orchard-workbench-"));
  t.after(() => rmSync(root, { force: true, recursive: true })); return root;
}
export class TestProvider implements AgentProvider {
  readonly name = "Test Provider";
  readonly capabilities = { modelCatalog: true, structuredOutput: "validated" as const, tools: false, nativeResume: false, textStream: false };
  readonly configSchema = { type: "object", required: ["executable"], properties: { executable: { type: "string" } }, additionalProperties: false };
  calls: TurnRequest[] = [];
  handler?: (request: TurnRequest) => Promise<ProviderResult>;
  constructor(readonly id = "test-provider") {}
  readonly sessionProvider: SessionProvider = {
    openSession: async (_setting: unknown, request: SessionOpenRequest): Promise<ProviderSessionHandle> => ({
      key: request.key, generation: 1,
      ref: { version: 1, kind: "codex", threadId: request.key, cwd: request.cwd },
    }),
    sendTurn: async (_handle: ProviderSessionHandle, request: SessionTurnRequest) => {
      await request.onAccepted(randomUUID());
      return this.turn(undefined, request);
    },
    interruptTurn: async () => {},
    releaseSession: async () => {},
  };
  async detect() { return { state: "ready" as const, version: "fixture" }; }
  async models() { return { models: [{ id: "test-model", name: "Test", source: "discovered" as const }] }; }
  async turn(_setting: unknown, request: TurnRequest): Promise<ProviderResult> {
    this.calls.push(request);
    if (this.handler) return this.handler(request);
    const input = JSON.parse(request.prompt.split("Node input (data):\n")[1]!);
    return { output: { action: input.action ?? "execute", reason: "fixture decision" }, modelId: request.modelId, providerId: this.id };
  }
}
export function exampleFiles(id = "example"): SourceFiles {
  const definition: Workflow = {
    formatVersion: 1, id, name: "检查并执行", inputSchema: { type: "object", properties: { action: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object" },
    entryNodeId: "a", defaults: { agent: { agentConfigId: "test-agent-config" } },
    nodes: [
      { id: "a", name: "读取输入", type: "code.nodejs", input: { source: "workflow" }, outputSchema: { type: "object" }, config: { script: "scripts/a.ts" } },
      { id: "b", name: "Agent 决策", type: "agent", input: { source: "node", nodeId: "a" }, outputSchema: { type: "object", required: ["action"], properties: { action: { type: "string" }, reason: { type: "string" } } }, config: { prompt: "Analyze input and choose execute or skip" } },
      { id: "route", name: "条件路由", type: "switch", input: { source: "node", nodeId: "b", pointer: "/action" }, outputSchema: true, config: { cases: [{ label: "execute", value: "execute" }, { label: "skip", value: "skip" }], defaultLabel: "other" } },
      { id: "c", name: "执行脚本", type: "shell", input: { source: "node", nodeId: "a" }, outputSchema: { type: "object" }, config: { script: "scripts/c.sh" } },
    ],
    edges: [{ id: "a-b", from: "a", to: "b" }, { id: "b-route", from: "b", to: "route" }, { id: "do", from: "route", to: "c", label: "execute" }, { id: "skip", from: "route", to: null, label: "skip" }, { id: "other", from: "route", to: null, label: "other" }],
    result: { source: "node", nodeId: "b" },
  };
  return {
    "workflow.json": JSON.stringify(definition, null, 2),
    "scripts/a.ts": "export default async function(input: Record<string,unknown>) { console.log('checking'); return {...input, checked:true}; }",
    "scripts/c.sh": "#!/bin/bash\nread -r input\nprintf 'executed\\n'\n",
  };
}
export function setup(t: TestContext, options: { models?: boolean } = {}) {
  const root = temporary(t), store = new TestStore(root), provider = new TestProvider(), providers = new ProviderRegistry(store).register(provider, process.execPath);
  providers.update(provider.id, { enabled: true, defaultModel: "test-model", ...(options.models === false ? {} : { models: [{ id: "test-model", name: "Test", source: "configured", enabled: true }] }) });
  const now = Date.now();
  store.exec("INSERT INTO agent_model_configs VALUES('test-agent-config','测试分析','',?,'test-model',1,1,?,?)", provider.id, now, now);
  store.exec("INSERT INTO agent_model_config_revisions VALUES('test-agent-config',1,'测试分析','',?,'test-model',1,?)", provider.id, now);
  const authoring = new AuthoringService(store, providers);
  return { root, store, provider, providers, authoring };
}
export async function publishExample(authoring: AuthoringService) {
  const draft = await authoring.create(undefined, randomUUID());
  const id = JSON.parse(authoring.snapshot(draft.id).files["workflow.json"]!).id;
  const updated = await authoring.update(draft.id, 0, exampleFiles(id));
  return authoring.publish(draft.id, updated.revision, randomUUID());
}
export async function until<T>(check: () => T | Promise<T>, timeout = 5000): Promise<Exclude<T, false | null | undefined>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value as Exclude<T, false | null | undefined>; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Timed out");
}
