import { configCoordinator } from "../config-git/coordinator.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../persistence/store.js";
import { compileScripts, json, readDefinition, readLayout } from "../persistence/files.js";
import { ProviderRegistry } from "../providers/registry.js";
import { assertSchema, resolveBinding } from "../domain/validation.js";
import { check, failure } from "../domain/errors.js";
import type { WorkflowNode, Workflow, NodeRun, Run, RunExecution } from "../domain/types.js";
import { executeProcess } from "./process.js";
import { executeScript } from "./script.js";
import type { WebBridgeGateway } from "../web-bridge/gateway.js";

export class GraphRunner {
  private current?: { id: string; controller: AbortController; job: Promise<void> };
  private closing = false;
  private enabled = false;
  private readonly activities = new Map<string, () => void>();
  private track(id: string) {
    if (!this.activities.has(id)) this.activities.set(id, configCoordinator(this.store).beginActivity(`run:${id}`));
  }
  private release(id: string) { this.activities.get(id)?.(); this.activities.delete(id); }
  constructor(readonly store: Store, readonly providers: ProviderRegistry, readonly webBridge?: WebBridgeGateway, autoStart = true) { if (autoStart) this.start(); }
  start() {
    configCoordinator(this.store).assertAvailable();
    for (const row of this.store.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued','running','cancel_requested')")) this.track(row.id);
    this.enabled = true; this.wake();
  }
  create(versionId: string, input: unknown, requestId: string) {
    return configCoordinator(this.store).withActivity("run:accept", () => {
      configCoordinator(this.store).assertAvailable();
      const version = this.store.version(versionId);
      assertSchema(input, version.definition.inputSchema, "工作流输入");
      this.store.assertWorkflowScripts(version.definition, true);
      for (const node of version.definition.nodes) {
        if (node.type === "agent") this.providers.resolve(node.config);
        if (node.type === "web-bridge") check(this.webBridge?.tools(node.config.application).some(tool => tool.toolId === node.config.tool), "UNKNOWN_TOOL", `未知浏览器工具: ${node.config.application}/${node.config.tool}`);
      }
      const result = this.store.command(`run:${versionId}`, requestId, input, () => {
        const id = randomUUID(), now = Date.now();
        this.store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES(?,?,'queued',?,?)", id, versionId, this.store.reference(input), now);
        for (const node of version.definition.nodes) this.store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,?,?,'pending')", randomUUID(), id, node.id, node.type);
        this.store.append("run", id, "run.queued", { versionId });
        return this.store.run(id);
      });
      if (["queued", "running", "cancel_requested"].includes(result.status)) this.track(result.id);
      this.wake(); return result;
    });
  }
  private editableDraft(id: string, revision: number) {
    const draft = this.store.draft(id);
    check(draft.revision === revision, "REVISION_CONFLICT", "草稿已更新，请刷新后重新测试");
    check(draft.status === "draft" && !this.store.turns(id).some(turn => turn.status === "running"), "DRAFT_BUSY", "草稿正在生成或发布，或已经发布");
    check(draft.validation.valid, "INVALID_WORKFLOW", "请先修复草稿校验错误");
    return draft;
  }
  async createDraft(draftId: string, revision: number, input: unknown, requestId: string) {
    return configCoordinator(this.store).withActivity("GraphRunner.createDraft", async () => {
      const scope = `draft-run:${draftId}`, command = { revision, input };
      if (this.store.one("SELECT * FROM command_receipts WHERE scope=? AND request_id=?", scope, requestId)) {
        return this.store.command<Run>(scope, requestId, command, () => { throw new Error("unreachable"); });
      }
      const draft = this.editableDraft(draftId, revision);
      const original = this.store.files.readTree(draft.artifactPath).files;
      const definition = await this.providers.freeze(readDefinition(original));
      assertSchema(input, definition.inputSchema, "工作流输入");
      const files = { ...original, "workflow.json": JSON.stringify(definition, null, 2) };
      readLayout(files);
      const compiled = await compileScripts(files, definition), tree = this.store.files.saveTree(files, compiled);
      const result = this.store.command(scope, requestId, command, () => {
        this.editableDraft(draftId, revision);
        this.store.assertWorkflowScripts(definition);
        for (const node of definition.nodes) {
          if (node.type === "agent") this.providers.resolve(node.config);
          if (node.type === "web-bridge") check(this.webBridge?.tools(node.config.application).some(tool => tool.toolId === node.config.tool), "UNKNOWN_TOOL", `未知浏览器工具: ${node.config.application}/${node.config.tool}`);
        }
        const id = randomUUID(), now = Date.now();
        this.store.exec("INSERT INTO runs(id,draft_id,draft_revision,snapshot_path,status,input_ref,created_at) VALUES(?,?,?,?,'queued',?,?)", id, draftId, revision, tree.path, this.store.reference(input), now);
        for (const node of definition.nodes) this.store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,?,?,'pending')", randomUUID(), id, node.id, node.type);
        this.store.append("run", id, "run.queued", { draftId, draftRevision: revision });
        return this.store.run(id);
      });
      if (["queued", "running", "cancel_requested"].includes(result.status)) this.track(result.id);
      this.wake(); return result;
    });
  }
  private execution(run: Run): RunExecution {
    if (run.workflowVersionId) return this.store.version(run.workflowVersionId);
    check(run.snapshotPath, "INVALID_SNAPSHOT", "草稿测试缺少运行快照");
    const tree = this.store.files.readTree(run.snapshotPath);
    return { definition: readDefinition(tree.files), layout: readLayout(tree.files), artifactPath: run.snapshotPath };
  }
  snapshot(id: string) {
    return this.store.transaction(() => {
      const run = this.store.run(id);
      return { ...run, version: run.workflowVersionId ? this.store.version(run.workflowVersionId) : null, execution: this.execution(run), nodes: this.store.nodes(id), attempts: this.store.attempts(id), lastSequence: this.store.lastSequence("run", id) };
    });
  }
  cancel(id: string) {
    const status = this.store.transaction(() => {
      const run = this.store.run(id);
      if (run.status === "queued") {
        this.store.exec("UPDATE runs SET status='cancelled',ended_at=? WHERE id=?", Date.now(), id);
        this.skipRemaining(id, "run_terminated");
        this.store.append("run", id, "run.cancelled", {});
      } else if (run.status === "running") {
        this.store.exec("UPDATE runs SET status='cancel_requested',cancel_requested_at=? WHERE id=?", Date.now(), id);
        this.store.append("run", id, "run.cancel_requested", {});
      }
      return this.store.run(id).status;
    });
    if (status === "cancel_requested" && this.current?.id === id) this.current.controller.abort();
    if (status === "cancelled" && this.current?.id !== id) this.release(id);
    return this.store.run(id);
  }
  wake() {
    if (!this.enabled) return;
    setImmediate(() => {
      if (this.current || this.closing) return;
      const next = this.store.one<{ id: string }>("SELECT id FROM runs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");
      if (!next) return;
      this.track(next.id);
      const controller = new AbortController();
      const job = this.execute(next.id, controller.signal).finally(() => { this.release(next.id); this.current = undefined; this.wake(); });
      this.current = { id: next.id, controller, job };
    });
  }
  async close() {
    this.closing = true;
    if (this.current) { this.cancel(this.current.id); await this.current.job; }
  }
  private skipRemaining(id: string, reason: string) { this.store.exec("UPDATE node_runs SET status='skipped',skip_reason=?,ended_at=? WHERE run_id=? AND status='pending'", reason, Date.now(), id); }
  private async execute(id: string, signal: AbortSignal) {
    let active: NodeRun | undefined, attemptId: string | undefined;
    try {
      const run = this.store.run(id), execution = this.execution(run);
      const tree = this.store.files.readTree(execution.artifactPath), workflow = readDefinition(tree.files);
      check(json(workflow) === json(execution.definition), "ARTIFACT_MISMATCH", "流程定义与运行快照不一致");
      this.store.transaction(() => {
        check(this.store.run(id).status === "queued", "RUN_ENDED", "运行已结束");
        this.store.exec("UPDATE runs SET status='running',started_at=? WHERE id=?", Date.now(), id);
        this.store.append("run", id, "run.started", {});
      });
      const outputs = new Map<string, unknown>();
      let next: string | null = workflow.entryNodeId;
      while (next !== null) {
        signal.throwIfAborted();
        const node = workflow.nodes.find(n => n.id === next)!;
        active = this.store.nodes(id).find(n => n.nodeId === node.id)!; attemptId = randomUUID();
        const value = resolveBinding(node.input, run.input, outputs);
        assertSchema(value, node.inputSchema ?? true, `${node.id} 输入`);
        this.store.transaction(() => {
          check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
          this.store.exec("UPDATE runs SET active_node_id=? WHERE id=?", node.id, id);
          const inputRef = this.store.reference(value), now = Date.now();
          this.store.exec("UPDATE node_runs SET status='running',input_ref=?,started_at=? WHERE id=?", inputRef, now, active!.id);
          this.store.exec("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,input_ref,started_at) VALUES(?,?,1,'running',?,?,?)", attemptId!, active!.id, json({ nodeType: node.type, config: node.config }), inputRef, now);
          this.store.append("run", id, "node.started", { input: value }, node.id, attemptId);
        });
        const emit = (type: string, payload: unknown) => {
          if (!signal.aborted) this.store.append("run", id, type, payload, node.id, attemptId);
        };
        let output: unknown, execution: unknown, route: NodeRun["route"];
        if (node.type === "switch") {
          const branch = node.config.cases!.find(c => c.value === value);
          const edge = workflow.edges.find(e => e.from === node.id && e.label === (branch?.label ?? node.config.defaultLabel))!;
          route = { edgeId: edge.id, value, reason: branch ? `匹配分支 ${branch.label}` : "未匹配条件，进入默认分支" };
          output = route; next = edge.to;
        } else {
          const result = node.type === "web-bridge"
            ? await this.webBridgeCall(node, value, signal)
            : node.type === "agent"
            ? await this.providers.run(node.config, {
              signal, cwd: this.store.root, prompt: `${node.config.prompt}\nNode input (data):\n${json(value)}`, schema: node.outputSchema, timeoutMs: node.config.timeoutMs,
              emit: event => emit(event.type, event.payload),
            }).then(result => ({ output: result.output, execution: { providerId: result.providerId, modelId: result.modelId, modelSource: result.modelSource, usage: result.usage } }))
            : node.type === "script"
              ? await this.libraryScript(node, value, signal)
              : await this.script(id, attemptId, node, value, tree.compiled[node.id], tree.files[node.config.script!], signal, emit);
          output = result.output; execution = result.execution;
          next = workflow.edges.find(e => e.from === node.id)?.to ?? null;
        }
        signal.throwIfAborted();
        assertSchema(output, node.outputSchema, `${node.id} 输出`);
        this.store.transaction(() => {
          check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
          const ref = this.store.reference(output), now = Date.now();
          this.store.exec("UPDATE node_runs SET status='succeeded',output_ref=?,route_json=?,ended_at=? WHERE id=?", ref, route ? json(route) : null, now, active!.id);
          this.store.exec("UPDATE node_attempts SET status='succeeded',output_ref=?,execution_json=?,ended_at=? WHERE id=?", ref, json({ config: node.config, ...(execution && typeof execution === "object" ? execution : {}), ...(route ? { route } : {}) }), now, attemptId!);
          this.store.exec("UPDATE runs SET active_node_id=? WHERE id=?", next, id);
          this.store.append("run", id, "node.succeeded", { output, ...(route ? { route } : {}) }, node.id, attemptId);
        });
        outputs.set(node.id, output); active = undefined; attemptId = undefined;
      }
      const output = resolveBinding(workflow.result, run.input, outputs);
      assertSchema(output, workflow.outputSchema, "工作流输出");
      signal.throwIfAborted();
      this.store.transaction(() => {
        check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
        this.store.exec("UPDATE runs SET status='succeeded',output_ref=?,active_node_id=NULL,ended_at=? WHERE id=?", this.store.reference(output), Date.now(), id);
        this.skipRemaining(id, "branch_not_selected");
        this.store.append("run", id, "run.succeeded", { output });
      });
    } catch (error) {
      this.store.transaction(() => {
        const run = this.store.run(id);
        if (!["queued", "running", "cancel_requested"].includes(run.status)) return;
        const cancelled = signal.aborted || run.status === "cancel_requested", status = cancelled ? "cancelled" : "failed";
        const detail = cancelled ? { code: "CANCELLED", message: "用户取消了运行" } : failure(error);
        const now = Date.now();
        if (active) {
          this.store.exec("UPDATE node_runs SET status=?,error_json=?,ended_at=? WHERE id=?", status, json(detail), now, active.id);
          if (attemptId) this.store.exec("UPDATE node_attempts SET status=?,error_json=?,ended_at=? WHERE id=?", status, json(detail), now, attemptId);
          this.store.append("run", id, `node.${status}`, detail, active.nodeId, attemptId);
        }
        this.store.exec("UPDATE runs SET status=?,error_json=?,active_node_id=NULL,ended_at=? WHERE id=?", status, json(detail), now, id);
        this.skipRemaining(id, cancelled ? "run_terminated" : "upstream_failed");
        this.store.append("run", id, `run.${status}`, detail);
      });
    }
  }
  private async webBridgeCall(node: WorkflowNode, input: unknown, signal: AbortSignal) {
    check(this.webBridge, "BROWSER_NOT_CONNECTED", "Web Bridge 未配置");
    const output = await this.webBridge.call(node.config.application!, node.config.tool!, input, { signal, timeoutMs: node.config.timeoutMs });
    assertSchema(output, node.outputSchema, `${node.id} Web Bridge 输出`);
    return { output, execution: { application: node.config.application, tool: node.config.tool, resultMode: node.config.resultMode ?? "result" } };
  }
  private async libraryScript(node: WorkflowNode, input: unknown, signal: AbortSignal) {
    const script = this.store.script(node.config.scriptId!), version = this.store.scriptVersion(node.config.scriptVersionId!);
    check(script.currentPublishedVersionId && version.status === "published" && version.scriptId === script.id, "SCRIPT_VERSION_INVALID", "工作流引用的脚本版本无效");
    assertSchema(input, version.inputSchema, `${node.id} 脚本输入`);
    const tree = this.store.files.readScriptTree(version.sourceRef);
    const timeoutMs = Math.min(version.timeoutMs, node.config.timeoutMs ?? version.timeoutMs);
    const result = await executeScript({ runtime: script.runtime, entryFile: version.entryFile, files: tree.files, resultMode: tree.definition?.resultMode, input, cwd: this.store.files.path("runs"), timeoutMs, signal });
    assertSchema(result.output, version.outputSchema, `${node.id} 脚本输出`);
    return { output: result.output, execution: { scriptId: script.id, scriptVersionId: version.id, exitCode: result.exitCode, durationMs: result.durationMs } };
  }
  private async script(runId: string, attemptId: string, node: WorkflowNode, input: unknown, compiled: string | undefined, shell: string | undefined, signal: AbortSignal, emit: (type: string, payload: unknown) => void) {
    const relative = `runs/${runId}/${attemptId}`, directory = this.store.files.path(relative);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const resultFile = join(directory, "result.json");
    let executable: string, args: string[];
    if (node.type === "code.nodejs") {
      check(compiled, "INVALID_SCRIPT", "缺少已编译脚本");
      writeFileSync(join(directory, "node.mjs"), compiled, { mode: 0o600 });
      const wrapper = `import {writeFileSync} from 'node:fs'; let text='';for await(const chunk of process.stdin)text+=chunk; const module=await import(${json(pathToFileURL(join(directory, "node.mjs")).href)});if(typeof module.default!=='function')throw new Error('Node.js script must export default function'); const result=await module.default(JSON.parse(text));writeFileSync(process.env.ORCHARD_RESULT_FILE,JSON.stringify(result ?? null));`;
      writeFileSync(join(directory, "entry.mjs"), wrapper, { mode: 0o600 });
      executable = process.execPath; args = [join(directory, "entry.mjs")];
    } else {
      check(shell !== undefined, "INVALID_SCRIPT", "Shell 脚本不存在");
      writeFileSync(join(directory, "script.sh"), shell, { mode: 0o600 });
      executable = "/bin/bash"; args = [join(directory, "script.sh")];
    }
    const result = await executeProcess({
      executable, args, cwd: directory, input: json(input), signal, timeoutMs: node.config.timeoutMs,
      env: { ORCHARD_RESULT_FILE: resultFile },
      onLog: (stream, chunk) => {
        for (let at = 0; at < chunk.length; at += 4096) emit("node.log", { stream, text: chunk.slice(at, at + 4096) });
      },
    });
    emit("node.process", { exitCode: result.exitCode, durationMs: result.durationMs, stderr: result.stderr.slice(-4000) });
    check(result.exitCode === 0, "PROCESS_FAILED", `脚本退出码 ${result.exitCode}: ${result.stderr.slice(-2000)}`);
    let output: unknown = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    if (node.type === "code.nodejs" || node.config.resultMode === "json") {
      let info;
      try { info = lstatSync(resultFile); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本没有生成 JSON 结果文件"); }
      check(!info.isSymbolicLink() && info.isFile() && info.size <= 8 * 1024 * 1024, "OUTPUT_LIMIT", "节点结果文件无效或超限");
      try { output = JSON.parse(readFileSync(resultFile, "utf8")); } catch { check(false, "INVALID_SCRIPT_OUTPUT", "脚本未生成合法 JSON 结果文件"); }
    }
    return { output, execution: { executable, exitCode: result.exitCode, durationMs: result.durationMs } };
  }
}
