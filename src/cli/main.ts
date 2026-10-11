#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { homedir } from "node:os";
import { Command } from "commander";
import { createServer } from "../server/app.js";
import { readWorkflowDetail } from "../server/workflow-detail.js";
import { AgentProfileRepository, AuthoringSessionRepository, ContinuationRepository, createDefaultWorkspace, EventRepository, initializeDatabase, RunRepository, ScheduleRepository, WorkflowRepository, WorkflowTaskRepository } from "../storage/database.js";
import { SettingsStore } from "../storage/settings.js";
import { AGENT_LAUNCHERS, CliPiClient, probeBackend, probePiReadiness, probeVersion, resolveCliBackends, validateAgentProfile, versionVerifier, type LauncherProfileOverrides } from "../integrations/pi/index.js";
import { PiAdapter } from "../integrations/pi/adapter.js";
import { PiAuthoringService } from "../authoring/pi-session.js";
import { WorkerLoop, WorkflowExecutionService } from "../runtime/index.js";
import { createLocalNodeRegistry } from "../runtime/local-nodes.js";
import { PersistentScheduler } from "../scheduler/index.js";
import { pathToFileURL } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { loadRegisteredBundle } from "../runtime/artifact-loader.js";
import { discoverWorkflows } from "../authoring/discovery.js";
import { publishWorkflow } from "../authoring/publish.js";
import { createWorkflowExport, publishWorkflowImport, validateWorkflowExport } from "../import-export/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7331;
const DEFAULT_DATA_DIR = `${homedir()}/.orchard`;

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" });
  child.on("error", () => process.stderr.write("Unable to open browser; open the displayed address manually.\n"));
  child.unref();
}

async function start(options: { host: string; port: string; open?: boolean; dataDir?: string }): Promise<void> {
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  if (options.host !== "127.0.0.1" && options.host !== "::1") {
    throw new Error("Only loopback listening is supported until remote access is validated");
  }
  const storage = initializeDatabase(options.dataDir ?? DEFAULT_DATA_DIR);
  let workspaceId: string;
  try {
    workspaceId = createDefaultWorkspace(storage);
  } catch (error) {
    storage.close();
    throw error;
  }
  const authority = `${options.host === "::1" ? "[::1]" : options.host}:${port}`;
  const workflows = new WorkflowRepository(storage);
  const agents = new AgentProfileRepository(storage);
  const runs = new RunRepository(storage);
  const schedules = new ScheduleRepository(storage);
  const tasks = new WorkflowTaskRepository(storage);
  const continuations = new ContinuationRepository(storage);
  const events = new EventRepository(storage);
  // Host CLI backends: trusted resolution (settings override -> documented
  // discovery list), pinned to absolute paths for every execution.
  const settings = new SettingsStore(storage.dataDir);
  const workspaceRoot = join(storage.dataDir, "workspaces", "default");
  const backends = await resolveCliBackends({ settings: await settings.read(), verify: versionVerifier() });
  for (const launcher of AGENT_LAUNCHERS) {
    const config = backends.get(launcher);
    process.stdout.write(config ? `CLI backend ${launcher}: ${config.executable} (${config.source})\n` : `CLI backend ${launcher}: not configured\n`);
  }
  const piClient = new CliPiClient({ registry: backends, workspaceRoot });
  const nodes = createLocalNodeRegistry({ agents, client: piClient });
  const workflowExecution = new WorkflowExecutionService(storage, nodes);
  const submitRun = (runId: string): void => { tasks.enqueueRun(runId); };
  const worker = new WorkerLoop(tasks, async ({ task, signal }) => {
      const run = runs.getRun(task.runId);
      if (!run) throw new Error('RUN_NOT_FOUND');
      const version = workflows.getVersion(run.workflowVersionId);
      if (!version) throw new Error("WORKFLOW_VERSION_NOT_FOUND");
      const input = run.inputRef === undefined ? null : JSON.parse(run.inputRef);
      const manifest = version.manifest as Record<string, unknown>;
      const loaded = typeof manifest.artifactPath === "string"
        ? (await loadRegisteredBundle({ instanceRoot: storage.dataDir, artifactPath: manifest.artifactPath, manifest: manifest as never, workflowId: version.workflowId, versionId: version.id })).module
        : await import(pathToFileURL(resolve(storage.dataDir, version.bundlePath)).href);
      const candidate = loaded.default ?? loaded.workflow ?? loaded.run;
      let output: unknown;
      if (typeof candidate === "function") {
        output = await candidate({ runId: run.id, signal, step: <T>(stepKey: string, stepInput: unknown) => workflowExecution.executeStep<T>(run.id, stepKey, stepInput as import("../core/contracts.js").StepRequest, signal), invokeTool: async () => { throw new Error("Worker tool execution is not configured"); } }, input);
      } else if (candidate && typeof candidate.run === "function") {
        output = await workflowExecution.execute(run.id, { ...candidate, ...workflows.getSourceConfiguration(version.id) }, input, signal);
      } else throw new Error("Workflow bundle does not export a workflow");
      return output ?? null;
  }, { workerId: `local:${process.pid}`, concurrency: 2 });
  const scheduler = new PersistentScheduler(schedules, runs, (workflowId, scheduledFor, occurrenceKey, workflowVersionId, scheduleId) => {
    const run = runs.createRunForWorkflow({ workflowId, ...(workflowVersionId ? { workflowVersionId } : {}), inputRef: JSON.stringify({ scheduledFor, occurrenceKey }), idempotencyKey: `cron:${scheduleId}:${occurrenceKey}` });
    submitRun(run.id);
    return run.id;
  });
  // Runs are durable. Resume queued work after a process restart instead of
  // leaving it visible in the UI forever with no in-memory queue entry.
  for (const run of runs.listRuns(100, 0)) if (run.status === "queued") submitRun(run.id);
  let schedulerTimer: ReturnType<typeof setInterval> | undefined;
  const pollScheduler = (): void => {
    for (const recover of [() => scheduler.tick(new Date()), () => continuations.resumeDue(), () => continuations.resumeChildren(), () => tasks.recoverExpired(), () => runs.recoverExpiredClaims()]) {
      try { recover(); } catch { process.stderr.write('Runtime recovery operation failed; will retry.\n'); }
    }
    for (let offset = 0; ; offset += 100) {
      const queued = runs.listRuns(100, offset, { status: 'queued' });
      for (const run of queued) submitRun(run.id);
      if (queued.length < 100) break;
    }
  };
  pollScheduler();
  schedulerTimer = setInterval(pollScheduler, 1_000);
  worker.start();
  const readTree = async (root: string, prefix: string): Promise<Record<string, Buffer>> => { const result: Record<string, Buffer> = {}; for (const entry of await readdir(root, { withFileTypes: true })) { const source = join(root, entry.name); const name = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) Object.assign(result, await readTree(source, name)); else result[name] = await readFile(source); } return result; };
  const authoringSessions = new AuthoringSessionRepository(storage);
  // Pi authoring reuses the same pi-cli backend; optionally pinned to a
  // profile via settings (authoring.profileId). Unconfigured keeps the 503.
  let authorPi: ((input: { draftId: string; prompt: string }) => Promise<unknown>) | undefined;
  if (backends.get("pi-cli")) {
    const overrides: LauncherProfileOverrides = {};
    const pinnedId = await settings.getAuthoringProfileId();
    const pinned = pinnedId ? agents.list().find((profile) => profile.id === pinnedId) : undefined;
    if (pinned) {
      try {
        const normalized = validateAgentProfile(pinned);
        Object.assign(overrides, {
          ...(normalized.model ? { model: normalized.model } : {}),
          ...(normalized.thinkingLevel ? { thinkingLevel: normalized.thinkingLevel } : {}),
          ...(normalized.timeoutMs ? { timeoutMs: normalized.timeoutMs } : {}),
          allowedTools: normalized.allowedTools,
        });
      } catch (error) {
        process.stderr.write(`Ignoring invalid authoring profile "${pinnedId}": ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    const authoring = new PiAuthoringService(new PiAdapter(piClient.forLauncher("pi-cli", overrides)), authoringSessions);
    const listDraftFiles = async (root: string): Promise<string[]> => {
      const files: string[] = [];
      const walk = async (dir: string, prefix: string): Promise<void> => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          else files.push(rel);
        }
      };
      await walk(root, "");
      // A fresh draft has no files yet; the conventional entry stays writable.
      return files.length > 0 ? files : ["worker.ts"];
    };
    authorPi = async ({ draftId, prompt }) => {
      const draft = workflows.getDraft(draftId);
      if (!draft) throw new Error("DRAFT_NOT_FOUND");
      const draftRoot = resolve(draft.rootPath, draftId);
      await mkdir(draftRoot, { recursive: true, mode: 0o700 });
      const session = authoringSessions.create({ workspaceId: draft.workspaceId, draftId });
      return await authoring.generate({
        sessionId: session.id,
        workspaceRoot: draftRoot,
        allowedFiles: await listDraftFiles(draftRoot),
        prompt,
        timeoutMs: 600_000,
      });
    };
  }
  const app = createServer({
    authority,
    listWorkflows: (limit, offset) => workflows.listWorkflows(workspaceId, limit, offset),
    deleteWorkflow: (id) => workflows.deleteWorkflow(id, workspaceId),
    getWorkflowDetail: async (id) => {
      const workflow = workflows.getWorkflow(id, workspaceId);
      if (!workflow) return undefined;
      const version = workflow.currentVersionId ? workflows.getVersion(workflow.currentVersionId) : undefined;
      return readWorkflowDetail(storage.dataDir, workflow, version);
    },
    listRuns: (limit, offset, filter) => runs.listRuns(limit, offset, filter),
    getRun: (id) => runs.getRun(id),
    listRunEvents: (id) => runs.listEvents(id),
    traceRun: (id) => runs.trace(id),
    rerunRun: (id, stepId) => stepId ? (() => { const replay = runs.rerunFromStep(id, stepId); submitRun(replay.id); return replay; })() : (() => { const original = runs.getRun(id); if (!original) throw new Error("RUN_NOT_FOUND"); const replay = runs.createRun({ workflowVersionId: original.workflowVersionId, ...(original.inputRef === undefined ? {} : { inputRef: original.inputRef }), retryOfRunId: id }); submitRun(replay.id); return replay; })(),
    listWorkflowVersions: (workflowId) => workflows.listVersions(workflowId),
    createDraft: (input) => workflows.createDraft({ workspaceId, rootPath: `${storage.dataDir}/workspaces/default/drafts`, ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}) }),
    getDraft: (id) => workflows.getDraft(id),
    ...(authorPi ? { authorPi } : {}),
    listTasks: (runId) => tasks.list(runId),
    getTask: (id) => tasks.get(id),
    listContinuations: (runId) => continuations.list(runId),
    listSchedulingDecisions: (runId) => runs.listSchedulingDecisions(runId),
    workerHealth: () => tasks.health(),
    listSchedules: () => schedules.list(),
    createSchedule: (input) => schedules.create(input),
    setScheduleEnabled: (id, enabled) => schedules.setEnabled(id, enabled),
    createWorkflow: async (input) => {
      const id = `workflow-${uuidv7()}`;
      const rootDir = join(storage.dataDir, "workspaces", "default", "workflows", id);
      await mkdir(rootDir, { recursive: true });
      const source = `import { defineWorkflow } from '@jiangliuhong/orchard/workflow';\nexport default defineWorkflow({ id: ${JSON.stringify(id)}, name: ${JSON.stringify(input.name)}, description: ${JSON.stringify(input.description ?? '')}, inputSchema: {}, outputSchema: {}, async run() { return {}; } });\n`;
      await writeFile(join(rootDir, "worker.ts"), source, { flag: "wx", mode: 0o600 });
      const workflow = workflows.createWorkflow({ id, workspaceId, name: input.name });
      await publishWorkflow({ workflows, workflowId: workflow.id, rootDir, entry: "worker.ts", outputDir: join(storage.dataDir, "versions", id) });
      return workflows.getWorkflow(id)!;
    },
    listDiscoveredWorkflows: async () => {
      const candidates = await discoverWorkflows(join(storage.dataDir, "workspaces"));
      return candidates.map((candidate) => {
        const targetWorkspace = workflows.getWorkspaceByName(candidate.workspace);
        const existing = targetWorkspace ? workflows.getWorkflow(candidate.id, targetWorkspace.id, true) : undefined;
        return {
          ...candidate,
          relativePath: relative(storage.dataDir, candidate.sourcePath),
          workspaceId: targetWorkspace?.id,
          alreadyAdded: Boolean(existing),
        };
      }).filter((candidate) => !candidate.alreadyAdded);
    },
    addDiscoveredWorkflow: async (input) => {
      const candidates = await discoverWorkflows(join(storage.dataDir, "workspaces"));
      const candidate = candidates.find((item) => item.workspace === input.workspace && item.id === input.id);
      if (!candidate) throw new Error("DISCOVERED_WORKFLOW_NOT_FOUND");
      const targetWorkspace = workflows.getWorkspaceByName(candidate.workspace);
      if (!targetWorkspace) throw new Error("WORKSPACE_NOT_FOUND");
      if (workflows.getWorkflow(candidate.id, targetWorkspace.id)) throw new Error("WORKFLOW_ALREADY_EXISTS");
      const workflow = workflows.createWorkflow({ id: candidate.id, workspaceId: targetWorkspace.id, name: candidate.name, description: candidate.description });
      const published = await publishWorkflow({
        workflows,
        workflowId: workflow.id,
        rootDir: candidate.sourcePath,
        entry: candidate.entry,
        outputDir: join(storage.dataDir, "versions", workflow.id),
      });
      return { workflow, versionId: published.versionId, sourcePath: relative(storage.dataDir, candidate.sourcePath), entry: candidate.entry };
    },
    listAgents: () => agents.list(),
    createAgent: (input) => agents.create(input),
    cliBackendStatus: async (deep: boolean) => {
      const items: unknown[] = [];
      for (const launcher of AGENT_LAUNCHERS) {
        const config = backends.get(launcher);
        if (!config) {
          items.push({ launcher, available: false, reason: "Not resolved: no settings override and no discovery hit. Set a path in the workbench settings." });
          continue;
        }
        const probe = await probeBackend(launcher, config);
        const item: Record<string, unknown> = {
          launcher,
          available: probe.available,
          path: config.executable,
          source: config.source,
          ...(probe.version ? { version: probe.version } : {}),
          ...(probe.reason ? { reason: probe.reason } : {}),
        };
        if (deep && launcher === "pi-cli") {
          // L2 is explicit and uncached: it must report what was just checked.
          const readiness: unknown[] = [];
          for (const profile of agents.list()) {
            if (profile.provider !== "pi-cli") continue;
            const result = await probePiReadiness(config.executable, profile.model);
            readiness.push({ profileId: profile.id, name: profile.name, state: result.state, ...(result.reason ? { reason: result.reason } : {}) });
          }
          item.readiness = readiness;
        }
        items.push(item);
      }
      return items;
    },
    setCliBackendPath: async (launcher: "pi-cli" | "codex-cli", path: string | null) => {
      const refresh = async () => {
        const fresh = await resolveCliBackends({ settings: await settings.read(), verify: versionVerifier() });
        const entry = fresh.get(launcher);
        if (entry) backends.set(launcher, entry);
        else backends.delete(launcher);
        const config = backends.get(launcher);
        if (!config) return { launcher, available: false, reason: "Not resolved after refresh." };
        const probe = await probeBackend(launcher, config);
        return { launcher, available: probe.available, path: config.executable, source: config.source, ...(probe.version ? { version: probe.version } : {}), ...(probe.reason ? { reason: probe.reason } : {}) };
      };
      if (path === null) {
        await settings.setCliExecutable(launcher, null);
        return await refresh();
      }
      if (!isAbsolute(path)) throw new Error("The executable path must be absolute.");
      const probe = await probeVersion(path);
      if (!probe.available) throw new Error(`Probe failed for "${path}": ${probe.reason ?? "unknown error"}`);
      await settings.setCliExecutable(launcher, path);
      return await refresh();
    },
    exportWorkflow: async (workflowId) => { const versionId = workflows.getCurrentVersionId(workflowId); if (!versionId) throw new Error("Workflow has no published version"); const version = workflows.getVersion(versionId); if (!version) throw new Error("Workflow version not found"); const root = resolve(storage.dataDir, version.sourcePath); const files = await readTree(root, "source"); const bundle = resolve(storage.dataDir, version.bundlePath); try { Object.assign(files, await readTree(bundle, "bundle")); } catch { /* source-only legacy versions */ } return createWorkflowExport({ app: { id: "orchard", name: "Orchard" }, workflow: { id: workflowId }, version: { id: version.id, number: version.versionNo, manifest: version.manifest }, files }); },
    importWorkflow: async (body) => { const pkg = validateWorkflowExport(body); const workflow = workflows.createWorkflow({ id: pkg.workflow.id, workspaceId, name: pkg.workflow.name ?? pkg.workflow.id }); const published = await publishWorkflowImport({ instanceRoot: storage.dataDir, pkg, persist: ({ sourcePath, bundlePath }) => { workflows.createVersion({ id: pkg.version.id, workflowId: workflow.id, contentHash: pkg.version.id, sourcePath, bundlePath: bundlePath ?? `${sourcePath}/../bundle/worker.mjs`, manifest: pkg.version.manifest, sdkVersion: "0.1.0" }); } }); return { workflowId: workflow.id, versionId: pkg.version.id, artifactPath: published.artifactPath }; },
    publishWorkflow: async (workflowId, entry) => {
      if (!workflows.getWorkflow(workflowId, workspaceId)) throw new Error("WORKFLOW_NOT_FOUND");
      const candidates = await discoverWorkflows(join(storage.dataDir, "workspaces"));
      const candidate = candidates.find(item => item.id === workflowId && item.workspace === "default");
      if (!candidate) throw new Error("WORKFLOW_SOURCE_NOT_FOUND");
      return publishWorkflow({ workflows, workflowId, rootDir: candidate.sourcePath, entry, outputDir: join(storage.dataDir, "versions", workflowId) });
    },
    createRun: (workflowId, input, idempotencyKey) => {
      const inputRef = JSON.stringify(input === undefined ? null : input);
      const run = runs.createRunForWorkflow({ workflowId, inputRef, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      submitRun(run.id);
      return run;
    },
    cancelRun: (id, reason) => {
      const changed = runs.requestCancel(id, reason);
      // requestCancel durably fences queued work; the worker fast path also
      // aborts active user code instead of waiting for the lease to expire.
      if (changed) worker.cancel(id, reason);
      return changed;
    },
    receiveEvent: (input) => {
      const result = events.deliverMatching({ ...input, createRun: (trigger, eventId) => {
        const workflowVersionId = trigger.workflowVersionId ?? workflows.getCurrentVersionId(trigger.workflowId);
        if (!workflowVersionId) throw new Error("WORKFLOW_NOT_FOUND");
        const run = runs.createRun({ workflowVersionId, inputRef: JSON.stringify(input.data), triggerId: trigger.id, idempotencyKey: `${input.source}:${input.eventId}:${trigger.id}` });
        return run.id;
      } });
      for (const runId of result.deliveries) if (runs.getRun(runId)?.status === "queued") submitRun(runId);
      return { ...result.event, deliveries: result.deliveries };
    },
  });
  try {
    const address = await app.listen({ host: options.host, port });
    process.stdout.write(`Orchard listening at ${address}\n`);
    process.stdout.write(`Data directory: ${storage.dataDir}\n`);
    if (options.open) openBrowser(address);
  } catch (error) {
    if (schedulerTimer) clearInterval(schedulerTimer);
    await worker.close();
    await app.close();
    storage.close();
    throw error;
  }
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
    if (schedulerTimer) clearInterval(schedulerTimer);
    await worker.close();
    await app.close();
    storage.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function doctor(options: { dataDir?: string }): Promise<void> {
  process.stdout.write(`Node.js: ${process.version}\n`);
  process.stdout.write(`Platform: ${process.platform}\n`);
  process.stdout.write("HTTP server: available\n");
  process.stdout.write("Persistence: SQLite schema available\n");
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const settings = new SettingsStore(dataDir);
  const backends = await resolveCliBackends({ settings: await settings.read(), verify: versionVerifier() });
  // L2 (pi provider readiness) needs stored profiles; only open an existing DB.
  // A running workbench holds the instance lock, so L2 degrades gracefully.
  const dbPath = join(dataDir, "orchard.db");
  let piProfiles: { name: string; model: string }[] = [];
  let profilesUnavailable = "";
  if (existsSync(dbPath)) {
    try {
      const storage = initializeDatabase(dataDir);
      try {
        piProfiles = new AgentProfileRepository(storage).list()
          .filter((profile) => profile.provider === "pi-cli")
          .map((profile) => ({ name: profile.name, model: profile.model }));
      } finally {
        storage.close();
      }
    } catch (error) {
      profilesUnavailable = error instanceof Error ? error.message : String(error);
    }
  }
  for (const launcher of AGENT_LAUNCHERS) {
    const config = backends.get(launcher);
    if (!config) {
      process.stdout.write(`CLI backend ${launcher}: not configured\n`);
      continue;
    }
    const probe = await probeBackend(launcher, config);
    process.stdout.write(
      `CLI backend ${launcher}: ${probe.available ? `available${probe.version ? ` (${probe.version})` : ""}` : `unavailable (${probe.reason ?? "probe failed"})`} at ${config.executable} (${config.source})\n`,
    );
    if (launcher === "pi-cli" && probe.available) {
      if (profilesUnavailable) {
        process.stdout.write(`  provider readiness: skipped (${profilesUnavailable})\n`);
      } else if (piProfiles.length === 0) {
        process.stdout.write("  provider readiness: no pi-cli agent profiles to check\n");
      }
      for (const profile of piProfiles) {
        const readiness = await probePiReadiness(config.executable, profile.model);
        process.stdout.write(`  readiness [${profile.name}]: ${readiness.state}${readiness.reason ? ` — ${readiness.reason}` : ""}\n`);
      }
    }
  }
}

const program = new Command()
  .name("orchard")
  .description("Orchard personal AI workflow workbench")
  .version("0.1.0");

program
  .command("start", { isDefault: true })
  .description("Start the Orchard workbench server")
  .option("--host <host>", "listen address", DEFAULT_HOST)
  .option("--port <port>", "listen port", String(DEFAULT_PORT))
  .option("--data-dir <path>", "data directory", DEFAULT_DATA_DIR)
  .option("--open", "open the workbench in a browser")
  .action(start);

program.command("doctor").description("Check the local Orchard environment").option("--data-dir <path>", "data directory to inspect", DEFAULT_DATA_DIR).action(doctor);

async function apiCommand(path: string, method: string, body: unknown, options: { url: string }): Promise<void> {
  const response = await fetch(new URL(path, options.url), { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`API ${response.status}: ${JSON.stringify(value)}`);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
const localUrl = 'http://127.0.0.1:7331';
program.command('event <name>').description('Send an idempotent event').requiredOption('--id <id>', 'event identity').option('--source <source>', 'event source', 'cli').option('--data <json>', 'JSON data', '{}').option('--url <url>', 'server URL', localUrl).action(async (name: string, options: { id: string; source: string; data: string; url: string }) => apiCommand('/api/events', 'POST', { name, id: options.id, source: options.source, data: JSON.parse(options.data) }, options));
program.command('schedule <id> <action>').description('Enable or disable a schedule').option('--url <url>', 'server URL', localUrl).action(async (id: string, action: string, options: { url: string }) => { if (!['enable', 'disable'].includes(action)) throw new Error('Action must be enable or disable'); await apiCommand(`/api/schedules/${encodeURIComponent(id)}/enabled`, 'POST', { enabled: action === 'enable' }, options); });
program.command('cancel <runId>').description('Cancel a run').option('--reason <reason>', 'reason', 'CLI cancellation').option('--url <url>', 'server URL', localUrl).action(async (id: string, options: { reason: string; url: string }) => apiCommand(`/api/runs/${encodeURIComponent(id)}/cancel`, 'POST', { reason: options.reason }, options));
program.command('rerun <runId>').description('Replay a run').option('--step <stepId>', 'replay boundary').option('--url <url>', 'server URL', localUrl).action(async (id: string, options: { step?: string; url: string }) => apiCommand(`/api/runs/${encodeURIComponent(id)}/rerun`, 'POST', options.step ? { stepId: options.step } : {}, options));
program.command('worker-health').description('Query worker health').option('--url <url>', 'server URL', localUrl).action(async (options: { url: string }) => apiCommand('/api/worker/health', 'GET', undefined, options));

await program.parseAsync(process.argv);
