import { privateWorkflowHistory } from "./workflow-history.js";
import type { DictionaryRequirement } from "../domain/dictionaries.js";
import type { CredentialResolver } from "../web-bridge/execution.js";
import { gitProjects } from "../project-git/service.js";
import { AppError } from "../domain/errors.js";
import type { RunAgentBinding } from "../domain/types.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { DictionaryExecution, REDACTED, safeExecutionFailure } from "../dictionaries/execution.js";
import { nodeDictionaryBindings, workflowDictionaryRequirements, workflowDictionarySensitivity } from "../domain/dictionaries.js";
import { prepareScriptRuntime } from "./dictionary-context.js";
import { randomUUID } from "node:crypto";
import { Store } from "../persistence/store.js";
import { compileScripts, json, readDefinition, readLayout } from "../persistence/files.js";
import { ProviderRegistry } from "../providers/registry.js";
import { assertSchema, resolveBinding } from "../domain/validation.js";
import { check, failure } from "../domain/errors.js";
import type { WorkflowNode, Workflow, NodeRun, Run, RunExecution } from "../domain/types.js";
import { executeScript, ScriptExecutionError } from "./script.js";
import type { WebBridgeGateway } from "../web-bridge/gateway.js";

export class GraphRunner {
  private current?: { id: string; controller: AbortController; job: Promise<void> };
  private closing = false;
  private enabled = false;
  private readonly privateInputs = new Map<string, unknown>();
  private privateHistory(workflow: Workflow) {
    return privateWorkflowHistory(workflow, (id, version) => this.store.scriptDefinition(id, version),
      (application, tool) => this.webBridge?.tools(application).find(item => item.toolId === tool)?.parameters);
  }
  private dictionaryRequirements(workflow: Workflow, runId?: string): DictionaryRequirement[] {
    const requirements = new Map(workflowDictionaryRequirements(workflow, (id, version) => this.store.scriptDefinition(id, version)).map(r => [r.dictionaryId, r]));
    const fixed = runId ? new DictionaryExecution(this.store).metadata("run", runId) : undefined;
    for (const node of workflow.nodes) if (node.type === "web-bridge") for (const ref of Object.values(node.config.credentialBindings ?? {})) {
      const current = fixed ? undefined : this.store.one<{ kind: "plain" | "encrypted"; entries_json: string }>(
        "SELECT d.kind,v.entries_json FROM dictionaries d JOIN dictionary_versions v ON v.dictionary_id=d.id AND v.id=d.current_version_id WHERE d.id=? AND d.deleted_at IS NULL", ref.dictionaryId);
      const kind = fixed ? fixed.find(b => b.dictionaryId === ref.dictionaryId)?.kind : current?.kind;
      check(kind, "DICTIONARY_NOT_FOUND", "凭据字典不存在", 422);
      if (current) {
        const entry = JSON.parse(current.entries_json)[ref.key];
        check(entry, "DICTIONARY_KEY_MISSING", "凭据字典键不存在", 422);
        check(entry.type === "string", "INVALID_CREDENTIALS", "凭据字典键必须为字符串", 422);
      }
      const prior = requirements.get(ref.dictionaryId);
      check(!prior || prior.kind === kind, "DICTIONARY_KIND_MISMATCH", "凭据字典类型不符", 422);
      requirements.set(ref.dictionaryId, { dictionaryId: ref.dictionaryId, kind, keys: [...new Set([...(prior?.keys ?? []), ref.key])].sort() });
    }
    return [...requirements.values()].sort((a, b) => a.dictionaryId.localeCompare(b.dictionaryId));
  }
  private readonly activities = new Map<string, () => void>();
  private track(id: string) {
    if (!this.activities.has(id)) this.activities.set(id, configCoordinator(this.store).beginActivity(`run:${id}`));
  }
  private release(id: string) { this.activities.get(id)?.(); this.activities.delete(id); }
  constructor(readonly store: Store, readonly providers: ProviderRegistry, readonly webBridge?: WebBridgeGateway, autoStart = true) { if (autoStart) this.start(); }
  start() {
    configCoordinator(this.store).assertAvailable();
    prepareScriptRuntime(this.store);
    for (const row of this.store.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued','running','cancel_requested')")) this.track(row.id);
    this.enabled = true; this.wake();
  }
  create(versionId: string, input: unknown, requestId: string) {
    return configCoordinator(this.store).withActivity("run:accept", () => {
      const scope = `run:${versionId}`;
      if (this.store.one("SELECT 1 FROM command_receipts WHERE scope IN (?,?) AND request_id=?", scope, `private-${scope}`, requestId)) {
        return configCoordinator(this.store).withAdmission(() => {
          const prior = this.store.workflowRunCommand<{ id: string }>(scope, requestId, input, () => { throw new Error("unreachable"); });
          const run = this.store.run(prior.id);
          if (["queued", "running", "cancel_requested"].includes(run.status)) this.track(run.id);
          this.wake(); return run;
        });
      }
      const version = this.store.version(versionId), definition = version.definition;
      assertSchema(input, definition.inputSchema, "工作流输入");
      this.store.assertWorkflowScripts(definition, true);
      const privateInput = this.privateHistory(definition);
      const inputRef = this.store.prepareReference(privateInput ? REDACTED : input), dependencies = new DictionaryExecution(this.store);
      const requirements = this.dictionaryRequirements(definition);
      return configCoordinator(this.store).withAdmission(() => {
        const result = this.store.workflowRunCommand(scope, requestId, input, () => {
          const admission = dependencies.validate(requirements);
          dependencies.validatePointers(definition, admission.bindings, input);
          const bindings = this.providers.modelConfigs.resolveWorkflow(definition);
          for (const node of definition.nodes) if (node.type === "web-bridge") check(this.webBridge?.tools(node.config.application).some(tool => tool.toolId === node.config.tool), "UNKNOWN_TOOL", `未知浏览器工具: ${node.config.application}/${node.config.tool}`);
          const id = randomUUID(), now = Date.now();
          this.store.exec("INSERT INTO runs(id,workflow_version_id,status,input_ref,created_at) VALUES(?,?,'queued',?,?)", id, versionId, this.store.attachPreparedReference(inputRef), now);
          for (const node of definition.nodes) this.store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,?,?,'pending')", randomUUID(), id, node.id, node.type);
          this.providers.modelConfigs.saveBindings(id, bindings); dependencies.save("run", id, admission.bindings);
          gitProjects(this.store).pin(id, definition);
          dependencies.assertFingerprint(admission.fingerprint, requirements.some(r => r.kind === "encrypted"));
          this.store.append("run", id, "run.queued", { versionId });
          return { id };
        }, privateInput);
        const run = this.store.run(result.id);
        if (privateInput && run.status === "queued" && !this.privateInputs.has(result.id)) this.privateInputs.set(result.id, structuredClone(input));
        if (["queued", "running", "cancel_requested"].includes(run.status)) this.track(run.id);
        this.wake(); return run;
      });
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
      if (this.store.one("SELECT * FROM command_receipts WHERE scope IN (?,?) AND request_id=?", scope, `private-${scope}`, requestId)) {
        return configCoordinator(this.store).withAdmission(() => {
          const result = this.store.workflowRunCommand<{ id: string }>(scope, requestId, command, () => { throw new Error("unreachable"); });
          const run = this.store.run(result.id);
          if (["queued", "running", "cancel_requested"].includes(run.status)) this.track(run.id);
          this.wake(); return run;
        });
      }
      const draft = this.editableDraft(draftId, revision);
      const original = this.store.files.readTree(draft.artifactPath).files;
      const definition = readDefinition(original);
      assertSchema(input, definition.inputSchema, "工作流输入");
      const files = { ...original, "workflow.json": JSON.stringify(definition, null, 2) };
      readLayout(files);
      const compiled = await compileScripts(files, definition), tree = this.store.files.saveTree(files, compiled);
      const privateInput = this.privateHistory(definition);
      const inputRef = this.store.prepareReference(privateInput ? REDACTED : input), dependencies = new DictionaryExecution(this.store);
      const requirements = this.dictionaryRequirements(definition);
      return configCoordinator(this.store).withAdmission(() => {
      const result = this.store.workflowRunCommand(scope, requestId, command, () => {
        this.editableDraft(draftId, revision);
        this.store.assertWorkflowScripts(definition);
        const admission = dependencies.validate(requirements);
        dependencies.validatePointers(definition, admission.bindings, input);
        const bindings = this.providers.modelConfigs.resolveWorkflow(definition);
        for (const node of definition.nodes) {
          if (node.type === "web-bridge") check(this.webBridge?.tools(node.config.application).some(tool => tool.toolId === node.config.tool), "UNKNOWN_TOOL", `未知浏览器工具: ${node.config.application}/${node.config.tool}`);
        }
        const id = randomUUID(), now = Date.now();
        this.store.exec("INSERT INTO runs(id,draft_id,draft_revision,snapshot_path,status,input_ref,created_at) VALUES(?,?,?,?,'queued',?,?)", id, draftId, revision, tree.path, this.store.attachPreparedReference(inputRef), now);
        for (const node of definition.nodes) this.store.exec("INSERT INTO node_runs(id,run_id,node_id,type,status) VALUES(?,?,?,?,'pending')", randomUUID(), id, node.id, node.type);
        this.providers.modelConfigs.saveBindings(id, bindings); dependencies.save("run", id, admission.bindings);
        gitProjects(this.store).pin(id, definition);
        dependencies.assertFingerprint(admission.fingerprint, requirements.some(r => r.kind === "encrypted"));
        this.store.append("run", id, "run.queued", { draftId, draftRevision: revision });
        return { id };
      }, privateInput);
      const run = this.store.run(result.id);
      if (privateInput && run.status === "queued" && !this.privateInputs.has(result.id)) this.privateInputs.set(result.id, structuredClone(input));
      if (["queued", "running", "cancel_requested"].includes(run.status)) this.track(run.id);
      this.wake(); return run;
      });
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
      return { ...run, version: run.workflowVersionId ? this.store.version(run.workflowVersionId) : null, execution: this.execution(run), agentBindings: this.providers.modelConfigs.bindings(id), nodes: this.store.nodes(id), attempts: this.store.attempts(id), lastSequence: this.store.lastSequence("run", id) };
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
    if (status === "cancelled" && this.current?.id !== id) { this.privateInputs.delete(id); this.release(id); gitProjects(this.store).forget(id); }
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
    for (const id of this.privateInputs.keys()) this.cancel(id);
    this.privateInputs.clear();
  }
  private skipRemaining(id: string, reason: string) { this.store.exec("UPDATE node_runs SET status='skipped',skip_reason=?,ended_at=? WHERE run_id=? AND status='pending'", reason, Date.now(), id); }
  private async execute(id: string, signal: AbortSignal) {
    let active: NodeRun | undefined, attemptId: string | undefined;
    let sensitiveFailure = true;
    try {
      const run = this.store.run(id), execution = this.execution(run);
      const tree = this.store.files.readTree(execution.artifactPath), workflow = readDefinition(tree.files);
      this.store.assertWorkflowScripts(workflow, true);
      check(json(workflow) === json(execution.definition), "ARTIFACT_MISMATCH", "流程定义与运行快照不一致");
      const resolveScript = (scriptId: string, versionId: string) => this.store.scriptDefinition(scriptId, versionId);
      const privateInput = run.inputRedacted === true || this.privateHistory(workflow);
      check(!privateInput || this.privateInputs.has(id), "INTERRUPTED", "服务重启，敏感运行参数需要重新填写");
      const input = privateInput ? this.privateInputs.get(id) : run.input;
      const policy = workflowDictionarySensitivity(workflow, resolveScript);
      if (privateInput) { workflow.nodes.forEach(node => policy.nodes.add(node.id)); policy.output = true; }
      const requirements = this.dictionaryRequirements(workflow, id);
      const declarations = nodeDictionaryBindings(workflow, resolveScript);
      const dictionaries = new DictionaryExecution(this.store).load("run", id, requirements);
      sensitiveFailure = privateInput;
      const bindings = new Map(this.providers.modelConfigs.bindings(id).map(binding => [binding.nodeId, binding]));
      for (const node of workflow.nodes) if (node.type === "agent") check(bindings.has(node.id), "AGENT_BINDING_MISSING", `${node.name} 缺少运行模型绑定`);
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
        const agentBinding = bindings.get(node.id);
        const sensitive = policy.nodes.has(node.id);
        sensitiveFailure = sensitive;
        active = this.store.nodes(id).find(n => n.nodeId === node.id)!; attemptId = randomUUID();
        const value = resolveBinding(node.input, input, outputs, dictionaries.plain);
        assertSchema(value, node.inputSchema ?? true, `${node.id} 输入`);
        this.store.transaction(() => {
          check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
          this.store.exec("UPDATE runs SET active_node_id=? WHERE id=?", node.id, id);
          const inputRef = this.store.reference(sensitive ? REDACTED : value), now = Date.now();
          this.store.exec("UPDATE node_runs SET status='running',input_ref=?,started_at=? WHERE id=?", inputRef, now, active!.id);
          this.store.exec("INSERT INTO node_attempts(id,node_run_id,attempt_no,status,execution_json,input_ref,started_at) VALUES(?,?,1,'running',?,?,?)", attemptId!, active!.id, json({ nodeType: node.type, config: node.config, inputRedacted: sensitive, outputRedacted: sensitive, logsRedacted: sensitive, ...(agentBinding ? { agentModelConfig: agentBinding } : {}) }), inputRef, now);
          this.store.append("run", id, "node.started", { input: sensitive ? REDACTED : value, inputRedacted: sensitive, logsRedacted: sensitive }, node.id, attemptId);
        });
        let actualProviderRevision: number | undefined;
        const emit = (type: string, payload: unknown) => {
          if (type === "provider.started") actualProviderRevision = (payload as { revision?: number }).revision;
          if (!signal.aborted && !sensitive) this.store.append("run", id, type, payload, node.id, attemptId);
        };
        let output: unknown, execution: unknown, route: NodeRun["route"];
        if (node.type === "switch") {
          const branch = node.config.cases!.find(c => c.value === value);
          const edge = workflow.edges.find(e => e.from === node.id && e.label === (branch?.label ?? node.config.defaultLabel))!;
          route = { edgeId: edge.id, value, reason: branch ? `匹配分支 ${branch.label}` : "未匹配条件，进入默认分支" };
          output = route; next = edge.to;
        } else {
          const result = node.type === "web-bridge"
            ? await this.webBridgeCall(node, value, signal, sensitive, (dictionaryId, key) => {
                const credential = dictionaries.value(dictionaryId, key);
                check(typeof credential === "string", "CREDENTIAL_UNAVAILABLE", "凭据字典键必须为字符串");
                return credential;
              })
            : node.type === "agent"
            ? node.config.project ? await this.projectAgent(id, node, attemptId!, agentBinding!, value, signal, emit) : await this.providers.run(agentBinding!, {
              signal, cwd: this.store.root, prompt: `${node.config.prompt}\nNode input (data):\n${json(value)}`, schema: node.outputSchema, timeoutMs: node.config.timeoutMs,
              emit: event => emit(event.type, event.payload),
            }).then(result => ({ output: result.output, execution: { agentModelConfig: agentBinding, providerId: result.providerId, modelId: result.modelId, providerRevision: actualProviderRevision, modelSource: result.modelSource, usage: result.usage } }))
            : node.type === "script"
              ? await this.libraryScript(node, value, signal, dictionaries.context(declarations.get(node.id)), sensitive)
              : await this.script(node, value, tree.compiled[node.id], tree.files, signal, emit, dictionaries.context(declarations.get(node.id)), sensitive);
          output = result.output; execution = result.execution;
          next = workflow.edges.find(e => e.from === node.id)?.to ?? null;
        }
        signal.throwIfAborted();
        assertSchema(output, node.outputSchema, `${node.id} 输出`);
        this.store.transaction(() => {
          check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
          const safeOutput = sensitive ? REDACTED : output;
          const safeRoute = route && sensitive ? { ...route, value: REDACTED } : route;
          const ref = this.store.reference(safeOutput), now = Date.now();
          this.store.exec("UPDATE node_runs SET status='succeeded',output_ref=?,route_json=?,ended_at=? WHERE id=?", ref, safeRoute ? json(safeRoute) : null, now, active!.id);
          this.store.exec("UPDATE node_attempts SET status='succeeded',output_ref=?,execution_json=?,ended_at=? WHERE id=?", ref, json({ config: node.config, ...(execution && typeof execution === "object" ? execution : {}), inputRedacted: sensitive, outputRedacted: sensitive, logsRedacted: sensitive, ...(safeRoute ? { route: safeRoute } : {}) }), now, attemptId!);
          this.store.exec("UPDATE runs SET active_node_id=? WHERE id=?", next, id);
          this.store.append("run", id, "node.succeeded", { output: safeOutput, outputRedacted: sensitive, logsRedacted: sensitive, ...(safeRoute ? { route: safeRoute } : {}) }, node.id, attemptId);
        });
        outputs.set(node.id, output); active = undefined; attemptId = undefined;
      }
      sensitiveFailure = policy.output;
      const output = resolveBinding(workflow.result, input, outputs, dictionaries.plain);
      assertSchema(output, workflow.outputSchema, "工作流输出");
      signal.throwIfAborted();
      this.store.transaction(() => {
        check(this.store.run(id).status === "running", "CANCELLED", "运行已停止");
        this.store.exec("UPDATE runs SET status='succeeded',output_ref=?,active_node_id=NULL,ended_at=? WHERE id=?", this.store.reference(policy.output ? REDACTED : output), Date.now(), id);
        this.skipRemaining(id, "branch_not_selected");
        this.store.append("run", id, "run.succeeded", { output: policy.output ? REDACTED : output, outputRedacted: policy.output });
      });
    } catch (error) {
      this.store.transaction(() => {
        const run = this.store.run(id);
        if (!["queued", "running", "cancel_requested"].includes(run.status)) return;
        const cancelled = signal.aborted || run.status === "cancel_requested", status = cancelled ? "cancelled" : "failed";
        const detail = cancelled ? { code: "CANCELLED", message: "用户取消了运行" } : safeExecutionFailure(error, sensitiveFailure);
        const now = Date.now();
        if (active) {
          if (sensitiveFailure) this.store.exec("UPDATE node_runs SET input_ref=? WHERE id=?", this.store.reference(REDACTED), active.id);
          this.store.exec("UPDATE node_runs SET status=?,error_json=?,ended_at=? WHERE id=?", status, json(detail), now, active.id);
          if (attemptId) this.store.exec("UPDATE node_attempts SET status=?,error_json=?,ended_at=? WHERE id=?", status, json(detail), now, attemptId);
          this.store.append("run", id, `node.${status}`, detail, active.nodeId, attemptId);
        }
        this.store.exec("UPDATE runs SET status=?,error_json=?,active_node_id=NULL,ended_at=? WHERE id=?", status, json(detail), now, id);
        this.skipRemaining(id, cancelled ? "run_terminated" : "upstream_failed");
        this.store.append("run", id, `run.${status}`, detail);
      });
    } finally {
      this.privateInputs.delete(id);
      try { gitProjects(this.store).forget(id); } catch { /* Startup recovery retries stale admission cleanup. */ }
    }
  }
  private async projectAgent(runId: string, node: WorkflowNode, attemptId: string, binding: RunAgentBinding, input: unknown, signal: AbortSignal, emit: (type: string, payload: unknown) => void) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "项目准备与分析超时")), node.config.timeoutMs ?? 600000);
    const combined = AbortSignal.any([signal, controller.signal]);
    let prepared: Awaited<ReturnType<ReturnType<typeof gitProjects>["prepare"]>> | undefined;
    let providerRevision: number | undefined;
    try {
      const pinned = gitProjects(this.store).pinned(runId, node.id);
      prepared = await gitProjects(this.store).prepare(pinned, runId, node.id, attemptId, combined, (type, payload) => {
        const metadata = payload as { sha?: string; durationMs?: number };
        if (metadata.sha) this.store.exec("UPDATE node_attempts SET execution_json=? WHERE id=?", json({ config: node.config, agentModelConfig: binding, project: { projectId: pinned.project.id, projectName: pinned.project.name, revision: pinned.project.revision, branch: pinned.project.branch, sha: metadata.sha, preparationMs: metadata.durationMs ?? 0, toolPolicyVersion: pinned.project.acceptedRiskVersion, unexpanded: null } }), attemptId);
        emit(type, payload);
      });
      const source = prepared.source;
      // Persist provenance before the provider starts, including on later failure/cancellation.
      const existing = this.store.attempts(runId).find(a => a.id === attemptId)?.execution ?? {};
      this.store.exec("UPDATE node_attempts SET execution_json=? WHERE id=?", json({ ...(existing as object), project: source }), attemptId);
      const result = await this.providers.run(binding, {
        executionContext: "project", sessionDirectory: prepared.sessionDirectory,
        cwd: prepared.workspace, signal: combined, timeoutMs: node.config.timeoutMs,
        prompt: `Project: ${source.projectName}\nBranch: ${source.branch}\nCommit: ${source.sha}\nUnexpanded entries: ${json(source.unexpanded)}\nAnalyze the available source. Do not push. Cite verifiable file paths and line numbers. Return only final JSON matching the output schema.\n${node.config.prompt}\nNode input (data):\n${json(input)}`,
        schema: node.outputSchema,
        emit: event => {
          // Raw tool/diagnostic streams can contain secrets or local paths. Keep final output and safe lifecycle only.
          if (event.type === "provider.started") {
            providerRevision = (event.payload as { revision: number }).revision;
            emit(event.type, { providerId: binding.providerId, requestedModel: binding.modelId, revision: providerRevision, transport: "native" });
          }
          else if (event.type === "provider.usage" || event.type === "provider.tool_completed") emit(event.type, event.payload);
        },
      });
      return { output: result.output, execution: { project: source, providerRevision, toolCallCount: result.toolCallCount, agentModelConfig: binding, providerId: result.providerId, modelId: result.modelId, modelSource: result.modelSource, usage: result.usage } };
    } catch (error) {
      if (controller.signal.aborted) throw new AppError("TIMEOUT", "项目准备与分析超时");
      if (signal.aborted) throw new AppError("CANCELLED", "项目分析已取消");
      // Provider errors can quote tool text, source or internal paths.
      if (error instanceof AppError && /^(PROJECT_|SSH_|TIMEOUT|CANCELLED)/.test(error.code)) throw error;
      throw new AppError(error instanceof AppError ? error.code : "PROJECT_ANALYSIS_FAILED", "项目分析失败，请检查 Provider 状态或输出 Schema");
    } finally { clearTimeout(timer); await prepared?.cleanup(); }
  }
  private async webBridgeCall(node: WorkflowNode, input: unknown, signal: AbortSignal, sensitive: boolean, resolveCredential: CredentialResolver) {
    check(this.webBridge, "BROWSER_NOT_CONNECTED", "Web Bridge 未配置");
    const output = await this.webBridge.call(node.config.application!, node.config.tool!, input, { signal, timeoutMs: node.config.timeoutMs, environmentId: node.config.environmentId, credentialBindings: node.config.credentialBindings, resolveCredential, omitHistoryArgs: sensitive });
    assertSchema(output, node.outputSchema, `${node.id} Web Bridge 输出`);
    return { output, execution: { application: node.config.application, tool: node.config.tool, resultMode: node.config.resultMode ?? "result" } };
  }
  private async libraryScript(node: WorkflowNode, input: unknown, signal: AbortSignal, dictionaryContext: import("../dictionaries/execution.js").DictionaryContext, sensitive: boolean) {
    const script = this.store.script(node.config.scriptId!), version = this.store.scriptVersion(node.config.scriptVersionId!);
    check(script.currentPublishedVersionId && version.status === "published" && version.scriptId === script.id, "SCRIPT_VERSION_INVALID", "工作流引用的脚本版本无效");
    assertSchema(input, version.inputSchema, `${node.id} 脚本输入`);
    const tree = this.store.files.readScriptTree(version.sourceRef);
    const timeoutMs = Math.min(version.timeoutMs, node.config.timeoutMs ?? version.timeoutMs);
    const result = await executeScript({ runtime: script.runtime, entryFile: version.entryFile, files: tree.files, resultMode: tree.definition?.resultMode, dictionaryBindings: tree.definition?.dictionaryBindings, dictionaryContext, sensitive, input, cwd: this.store.files.path("runs"), timeoutMs, signal });
    assertSchema(result.output, version.outputSchema, `${node.id} 脚本输出`);
    return { output: result.output, execution: { scriptId: script.id, scriptVersionId: version.id, exitCode: result.exitCode, durationMs: result.durationMs } };
  }
  private async script(node: WorkflowNode, input: unknown, compiled: string | undefined, sources: import("../domain/types.js").SourceFiles, signal: AbortSignal, emit: (type: string, payload: unknown) => void, dictionaryContext: import("../dictionaries/execution.js").DictionaryContext, sensitive: boolean) {
    const entryFile = node.config.script!.replace(/^scripts\//, "");
    const files = Object.fromEntries(Object.entries(sources).filter(([path]) => path.startsWith("scripts/") && (node.type === "shell" ? path.endsWith(".sh") : /\.(ts|js|mjs)$/.test(path))).map(([path, source]) => [path.slice(8), source]));
    if (node.type === "code.nodejs") check(compiled, "INVALID_SCRIPT", "缺少已编译脚本");
    const result = await executeScript({
      runtime: node.type === "shell" ? "shell" : "nodejs", entryFile, files, compiledSource: compiled,
      resultMode: node.config.resultMode, input, cwd: this.store.files.path("runs"), timeoutMs: node.config.timeoutMs, signal,
      dictionaryBindings: node.config.dictionaryBindings, dictionaryContext, sensitive,
      onLog: (stream, chunk) => {
        for (let at = 0; at < chunk.length; at += 4096) emit("node.log", { stream, text: chunk.slice(at, at + 4096) });
      },
    }).catch(error => {
      if (error instanceof ScriptExecutionError) emit("node.process", { exitCode: error.execution.exitCode, durationMs: error.execution.durationMs, stderr: error.execution.stderr.slice(-4000) });
      throw error;
    });
    emit("node.process", { exitCode: result.exitCode, durationMs: result.durationMs, stderr: result.stderr.slice(-4000) });
    return { output: result.output, execution: { exitCode: result.exitCode, durationMs: result.durationMs } };
  }
}
