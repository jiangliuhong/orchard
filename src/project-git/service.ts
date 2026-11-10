import { existsSync, readdirSync, renameSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Store } from "../persistence/store.js";
import type { Workflow } from "../domain/types.js";
import { AppError, check, failure } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { ProjectFiles, safeId } from "./files.js";
import { normalizeRemote, validateBranch, validateProfile, validateKeyFiles, sshEnvironment, shellQuote } from "./ssh.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { PROJECT_RISK_VERSION, type GitProject, type ProjectBinding, type SshProfile, type ProjectOperation, type ProjectSource } from "./types.js";

const projectProperties = { id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$" }, name: { type: "string", minLength: 1, maxLength: 200 }, remoteUrl: { type: "string", maxLength: 2000 }, branch: { type: "string", maxLength: 500 }, sshProfileId: { type: "string", minLength: 1 }, enabled: { type: "boolean" }, revision: { type: "integer", minimum: 0 }, acceptedRiskVersion: { type: "integer", const: PROJECT_RISK_VERSION } };
const active = new Set(["queued", "running", "cancel_requested"]);
export class GitProjects {
  readonly files: ProjectFiles;
  private storageNames = new Map<string, string>();
  private resourceOwners = new Map<string, string>();
  storageMetadata() { return { names: new Map(this.storageNames), owners: new Map(this.resourceOwners), activeProjects: new Set(this.resourceOwners.values()) }; }
  private locks = new Map<string, Promise<void>>();
  private operations = new Map<string, ProjectOperation>();
  private checks = new Map<string, number>();
  private jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(readonly store: Store) { this.files = new ProjectFiles(store.root); for (const p of this.list()) this.storageNames.set(p.id, p.name); }
  list(): GitProject[] {
    const values = this.files.read<GitProject[]>(["projects.json"], []);
    check(Array.isArray(values), "PROJECT_CONFIG_FAILED", "项目配置格式无效");
    for (const project of values) this.validateStoredProject(project);
    check(new Set(values.map(p => p.id)).size === values.length, "PROJECT_CONFIG_FAILED", "项目 ID 重复");
    return values;
  }
  private validateStoredProject(project: unknown): asserts project is GitProject {
    assertSchema(project, { type: "object", properties: { ...projectProperties, revision: { type: "integer", minimum: 1 }, acceptedRiskVersion: { type: "integer", minimum: 0 } }, required: ["id", "name", "remoteUrl", "branch", "sshProfileId", "enabled", "revision"], additionalProperties: false }, "本机项目");
  }
  profiles(): SshProfile[] {
    try {
      const path = this.files.path("ssh-profiles.json");
      if (existsSync(path)) { const info = lstatSync(path); check(info.isFile() && !(info.mode & 0o077), "SSH_PROFILE_INVALID", "SSH 档案文件须为仅账户可访问的普通文件"); }
      const profiles = this.files.read<SshProfile[]>(["ssh-profiles.json"], []);
      check(Array.isArray(profiles), "SSH_PROFILE_INVALID", "SSH 档案配置无效");
      for (const profile of profiles) validateProfile(profile);
      check(new Set(profiles.map(p => p.id)).size === profiles.length, "SSH_PROFILE_INVALID", "SSH 档案 ID 重复");
      return profiles;
    } catch { throw new AppError("SSH_PROFILE_INVALID", "本机 SSH 档案配置无效，请由管理员检查"); }
  }
  profileViews() { return this.profiles().map(profile => {
    let state = "available";
    try { validateKeyFiles(profile); } catch { state = "unavailable"; }
    return { id: profile.id, name: profile.name, state };
  }); }
  save(input: unknown, id?: string) {
    return configCoordinator(this.store).withWrite(() => {
      assertSchema(input, { type: "object", properties: projectProperties, required: id ? ["revision"] : ["id", "name", "remoteUrl", "branch", "sshProfileId", "enabled"], additionalProperties: false }, "项目");
      const data = input as GitProject, projects = this.list(), current = id ? projects.find(p => p.id === id) : undefined;
      check(!id || current, "PROJECT_NOT_AVAILABLE", "项目不存在");
      check(!current || current.revision === data.revision, "REVISION_CONFLICT", "项目配置已更新，请刷新");
      check(!id || !data.id || data.id === id, "PROJECT_INVALID_ID", "不能修改项目 ID");
      const project = { ...current, ...data, id: id ?? data.id, revision: (current?.revision ?? 0) + 1 };
      safeId(project.id);
      check(current || !projects.some(p => p.id === project.id), "PROJECT_CONFLICT", "项目 ID 已存在");
      validateBranch(project.branch);
      const profile = this.profiles().find(p => p.id === project.sshProfileId);
      check(profile, "SSH_PROFILE_INVALID", "请选择有效本机 SSH 档案");
      project.remoteUrl = normalizeRemote(project.remoteUrl, profile);
      check(!project.enabled || project.acceptedRiskVersion === PROJECT_RISK_VERSION, "PROJECT_RISK_NOT_ACCEPTED", "启用项目须明确接受本机 Agent 操作及源码发送风险");
      this.files.write(["projects.json"], [...projects.filter(p => p.id !== project.id), project]);
      this.storageNames.set(project.id, project.name);
      return project;
    });
  }
  binding(id: string): ProjectBinding {
    const project = this.list().find(p => p.id === id);
    check(project?.enabled, "PROJECT_NOT_AVAILABLE", "项目不存在或已禁用");
    check(project.acceptedRiskVersion === PROJECT_RISK_VERSION, "PROJECT_RISK_NOT_ACCEPTED", "请重新确认项目风险策略");
    const profile = this.profiles().find(p => p.id === project.sshProfileId);
    check(profile, "SSH_AUTH_FAILED", "项目 SSH 档案不可用");
    validateBranch(project.branch); normalizeRemote(project.remoteUrl, profile); validateKeyFiles(profile);
    return { project, profile };
  }
  assertWorkflow(workflow: Workflow) {
    for (const node of workflow.nodes) if (node.type === "agent" && node.config.project) this.binding(node.config.project.projectId);
  }
  pin(runId: string, workflow: Workflow) {
    const bindings: Record<string, ProjectBinding> = {};
    for (const node of workflow.nodes) if (node.type === "agent" && node.config.project) bindings[node.id] = this.binding(node.config.project.projectId);
    if (Object.keys(bindings).length) this.files.write(["runs", `${safeId(runId)}.json`], bindings);
  }
  pinned(runId: string, nodeId: string): ProjectBinding {
    const bindings = this.files.read<Record<string, ProjectBinding>>(["runs", `${safeId(runId)}.json`], {});
    check(bindings[nodeId], "PROJECT_NOT_AVAILABLE", "项目入队快照缺失，禁止使用可变配置替代");
    const binding = bindings[nodeId]!;
    this.validateStoredProject(binding.project); validateProfile(binding.profile);
    validateBranch(binding.project.branch); normalizeRemote(binding.project.remoteUrl, binding.profile);
    check(binding.project.acceptedRiskVersion === PROJECT_RISK_VERSION, "PROJECT_RISK_NOT_ACCEPTED", "入队项目风险策略已过期");
    return binding;
  }
  forget(runId: string) { this.files.remove("runs", `${safeId(runId)}.json`); }
  private async locked<T>(key: string, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    this.locks.set(key, next);
    // A cancelled waiter must not release or overtake the current holder.
    let onAbort!: () => void;
    try {
      await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new AppError("CANCELLED", "项目锁等待已取消"));
        signal.addEventListener("abort", onAbort, { once: true }); if (signal.aborted) onAbort();
      })]);
    } catch (error) {
      void previous.then(() => { release(); if (this.locks.get(key) === next) this.locks.delete(key); });
      throw error;
    } finally { signal.removeEventListener("abort", onAbort); }
    try { signal.throwIfAborted(); return await action(); }
    finally { release(); if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private transport(directory: string, profile: SshProfile) {
    const env = sshEnvironment(directory, profile);
    return { ...env, ORCHARD_PROJECT_PROCESS_DIR: directory, GIT_SSH_COMMAND: shellQuote(env.GIT_SSH!) };
  }
  check(id: string): ProjectOperation {
    return configCoordinator(this.store).withActivity("project:check-accept", () => {
      const project = this.list().find(p => p.id === id); check(project, "PROJECT_NOT_AVAILABLE", "项目不存在");
      const profile = this.profiles().find(p => p.id === project.sshProfileId); check(profile, "SSH_AUTH_FAILED", "项目 SSH 档案不可用");
      check(this.jobs.size < 2 && Date.now() - (this.checks.get(id) ?? 0) > 3000, "PROJECT_CHECK_BUSY", "连接检测过于频繁，请稍后重试");
      const operation: ProjectOperation = { id: randomUUID(), projectId: id, phase: "connecting", status: "running", startedAt: Date.now() };
      this.checks.set(id, Date.now());
      if (this.operations.size > 100) for (const [key, value] of this.operations) if (value.status !== "running") { this.operations.delete(key); break; }
      this.operations.set(operation.id, operation);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "连接检测超时")), 60000);
      const done = configCoordinator(this.store).withActivity("project:check", async () => {
        // Register the job before any synchronous setup failure can reach cleanup.
        await Promise.resolve();
        try {
          const directory = this.files.directory("staging", operation.id);
          const result = await git(directory, ["ls-remote", "--heads", normalizeRemote(project.remoteUrl, profile)], controller.signal, this.transport(directory, profile));
          operation.branches = result.toString().split("\n").filter(Boolean).map(line => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? "");
          check(operation.branches.includes(project.branch), "PROJECT_BRANCH_NOT_FOUND", "远端分支不存在");
          operation.status = "completed"; operation.phase = "ready";
        } catch (error) { operation.status = "failed"; operation.phase = "failed"; operation.error = this.safeFailure(error); }
        finally { clearTimeout(timer); operation.completedAt = Date.now(); try { this.files.remove("staging", operation.id); } catch { /* Startup recovery retries controlled staging cleanup. */ } this.jobs.delete(operation.id); }
      });
      this.jobs.set(operation.id, { controller, done });
      return operation;
    });
  }
  operation(id: string) { const result = this.operations.get(id); check(result, "NOT_FOUND", "检测记录已过期"); return result; }
  private safeFailure(error: unknown) {
    const detail = failure(error);
    return /^(PROJECT_|SSH_|TIMEOUT|CANCELLED)/.test(detail.code) ? detail : { code: "PROJECT_IO_FAILED", message: "项目资源操作失败，请检查磁盘和权限" };
  }
  async prepare(binding: ProjectBinding, runId: string, nodeId: string, attemptId: string, signal: AbortSignal, emit: (type: string, payload: unknown) => void) {
    const { project, profile } = binding;
    const ids = [runId, nodeId, attemptId].map(safeId), leaseParts = ["leases", safeId(runId), `${safeId(nodeId)}.json`];
    const stagingId = randomUUID(), started = Date.now();
    const workspaceParts = ["workspaces", ...ids], sessionParts = ["sessions", ...ids];
    const cacheParts = ["cache", safeId(project.id), String(project.revision)];
    const cache = this.files.path(...cacheParts), ref = `refs/orchard/leases/${ids.join("/")}`;
    const ownership = [`project-git/${workspaceParts.join("/")}`, `project-git/${sessionParts.join("/")}`, `project-git/${leaseParts.join("/")}`, `project-git/staging/${stagingId}`];
    for (const prefix of ownership) this.resourceOwners.set(prefix, project.id);
    let retained = false;
    const base = { projectId: project.id, branch: project.branch };
    const event = (phase: string, extra = {}) => emit(`project.${phase}`, { ...base, phase, durationMs: Date.now() - started, ...extra });
    const cleanup = async () => {
      try {
        this.files.remove(...workspaceParts); this.files.remove(...sessionParts); this.files.remove("staging", stagingId);
        if (retained && existsSync(cache)) await this.locked(`${project.id}:${project.revision}`, AbortSignal.timeout(5000), () => git(cache, ["update-ref", "-d", ref], AbortSignal.timeout(30000)));
        this.files.remove(...leaseParts);
        for (const prefix of ownership) this.resourceOwners.delete(prefix);
      } catch { try { event("cleanup_failed"); } catch { /* Store may be closing. */ } this.scheduleRecovery(); }
    };
    try {
      event("preparing");
      this.files.write(leaseParts, { runId, nodeId, attemptId, projectId: project.id, revision: project.revision, ref, stagingId, state: "preparing" });
      const staging = this.files.directory("staging", stagingId), env = this.transport(staging, profile);
      const sha = await this.locked(`${project.id}:${project.revision}`, signal, async () => {
        event("fetching");
        const remote = normalizeRemote(project.remoteUrl, profile);
        const fresh = !existsSync(cache);
        if (fresh) {
          const cloned = this.files.path("staging", stagingId, "clone");
          await git(staging, ["clone", "--bare", "--no-recurse-submodules", "--template=", "--single-branch", "--branch", project.branch, "--no-tags", "--", remote, cloned], signal, env);
          this.files.directory("cache", project.id);
          renameSync(cloned, cache);
        } else await git(cache, ["fetch", "--no-tags", "--no-recurse-submodules", "--", remote, `+refs/heads/${project.branch}:refs/orchard/current`], signal, env);
        const target = (await git(cache, ["rev-parse", "--verify", `${fresh ? `refs/heads/${project.branch}` : "refs/orchard/current"}^{commit}`], signal)).toString().trim();
        check(/^[a-f0-9]{40,64}$/.test(target), "PROJECT_FETCH_FAILED", "无法固定项目 commit");
        // Set before awaiting: update-ref may have committed just before a cancellation is observed.
        retained = true;
        await git(cache, ["update-ref", ref, target], signal);
        this.files.write(leaseParts, { runId, nodeId, attemptId, projectId: project.id, revision: project.revision, ref, stagingId, sha: target, state: "pinned" });
        return target;
      });
      event("preparing", { phase: "materializing", sha });
      const workspace = this.files.directory(...workspaceParts), sessionDirectory = this.files.directory(...sessionParts);
      const unexpanded = await materialize(cache, sha, workspace, signal, { ORCHARD_PROJECT_PROCESS_DIR: staging });
      const source: ProjectSource = { ...base, projectName: project.name, revision: project.revision, sha, preparationMs: Date.now() - started, toolPolicyVersion: PROJECT_RISK_VERSION, unexpanded };
      event("ready", { sha, unexpanded });
      return { workspace, sessionDirectory, source, cleanup };
    } catch (error) { await cleanup(); const detail = this.safeFailure(error); throw new AppError(detail.code, detail.message); }
  }
  private retryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private recoveryJob?: Promise<void>;
  private scheduleRecovery() {
    if (this.closed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.recoveryJob = Promise.resolve().then(() => configCoordinator(this.store).withActivity("project:cleanup-retry", () => this.recover())).catch(() => this.scheduleRecovery());
    }, 10000);
    this.retryTimer.unref();
  }
  private processAlive(parts: string[]) {
    try {
      const path = this.files.path(...parts, "process.json");
      if (!existsSync(path)) return false;
      const record = this.files.read<{ pid: number }>([...parts, "process.json"]);
      if (!Number.isInteger(record.pid) || record.pid <= 0) return true;
      try { process.kill(record.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } catch { return true; } // Corrupt/unreadable records must never justify deletion.
  }
  private sessionAlive(runId: string) {
    try {
      const root = this.files.path("sessions", runId);
      if (!existsSync(root)) return false;
      for (const node of readdirSync(root)) for (const attempt of readdirSync(this.files.path("sessions", runId, safeId(node)))) {
        if (this.processAlive(["sessions", runId, node, safeId(attempt)])) return true;
      }
      return false;
    } catch { return true; }
  }
  async recover() {
    // Store.recoverBusiness runs first. A surviving/reused PID is conservatively treated as a live holder;
    // never kill an unverified PID or delete its workspace merely because the database says interrupted.
    const keep = new Set(this.store.all<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued','running','cancel_requested')").map(r => r.id));
    const stages = new Set<string>(this.jobs.keys());
    let retry = false;
    const leases = this.files.path("leases");
    if (existsSync(leases)) for (const runId of readdirSync(leases)) {
      try {
        safeId(runId);
        const values: { stagingId: string; projectId: string; nodeId: string; attemptId: string }[] = [];
        for (const name of readdirSync(this.files.path("leases", runId))) {
          check(name.endsWith(".json"), "PROJECT_PATH_INVALID", "租约记录无效");
          const lease = this.files.read<{ stagingId: string; projectId: string; nodeId: string; attemptId: string }>(["leases", runId, name]);
          for (const id of [lease.stagingId, lease.projectId, lease.nodeId, lease.attemptId]) safeId(id);
          values.push(lease);
          for (const prefix of [`project-git/workspaces/${runId}/${lease.nodeId}/${lease.attemptId}`, `project-git/sessions/${runId}/${lease.nodeId}/${lease.attemptId}`, `project-git/leases/${runId}/${name}`, `project-git/staging/${lease.stagingId}`]) this.resourceOwners.set(prefix, lease.projectId);
        }
        const live = this.sessionAlive(runId) || values.some(v => this.processAlive(["staging", v.stagingId]));
        if (live || keep.has(runId)) {
          if (live && !keep.has(runId)) retry = true;
          keep.add(runId); for (const value of values) stages.add(value.stagingId);
        }
      } catch { keep.add(runId); retry = true; }
    }
    for (const name of ["workspaces", "sessions", "leases"] as const) {
      const root = this.files.path(name);
      if (existsSync(root)) for (const id of readdirSync(root)) if (!keep.has(id)) {
        try {
          // Sessions may exist without a lease after a partial write. Liveness still wins.
          if (this.sessionAlive(id)) { keep.add(id); retry = true; continue; }
          this.files.remove(name, safeId(id));
        } catch { keep.add(id); retry = true; }
      }
    }
    const admissions = this.files.path("runs");
    if (existsSync(admissions)) for (const file of readdirSync(admissions)) if (file.endsWith(".json") && !keep.has(file.slice(0, -5))) {
      try { this.files.remove("runs", file); } catch { retry = true; }
    }
    const staging = this.files.path("staging");
    if (existsSync(staging)) for (const id of readdirSync(staging)) if (!stages.has(id)) {
      try {
        if (this.processAlive(["staging", safeId(id)])) { retry = true; continue; }
        this.files.remove("staging", id);
      } catch { retry = true; }
    }
    const cache = this.files.path("cache");
    if (existsSync(cache)) for (const id of readdirSync(cache)) {
      try {
        for (const revision of readdirSync(this.files.path("cache", safeId(id)))) {
          const directory = this.files.path("cache", id, safeId(revision));
          check(lstatSync(directory).isDirectory(), "PROJECT_PATH_INVALID", "项目缓存目录无效");
          await this.locked(`${id}:${revision}`, AbortSignal.timeout(30000), async () => {
            const refs = (await git(directory, ["for-each-ref", "--format=%(refname)", "refs/orchard/leases/"], AbortSignal.timeout(30000))).toString().trim().split("\n").filter(Boolean);
            for (const ref of refs) if (!keep.has(ref.split("/")[3]!) && !this.store.one("SELECT id FROM runs WHERE id=? AND status IN ('queued','running','cancel_requested')", ref.split("/")[3]!)) await git(directory, ["update-ref", "-d", ref], AbortSignal.timeout(30000));
          });
        }
      } catch { retry = true; }
    }
    for (const [prefix] of this.resourceOwners) {
      const resource = prefix.replace(/^project-git\//, "");
      try { if (!existsSync(this.files.path(...resource.split("/")))) this.resourceOwners.delete(prefix); } catch { retry = true; }
    }
    if (retry) this.scheduleRecovery();
  }
  async close() {
    this.closed = true; if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    await this.recoveryJob;
  }
}
const services = new WeakMap<Store, GitProjects>();
export function gitProjects(store: Store) { let service = services.get(store); if (!service) { service = new GitProjects(store); services.set(store, service); } return service; }
