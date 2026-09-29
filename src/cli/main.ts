#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { homedir } from "node:os";
import { Command } from "commander";
import { createServer } from "../server/app.js";
import { AgentProfileRepository, createDefaultWorkspace, EventRepository, initializeDatabase, RunRepository, ScheduleRepository, WorkflowRepository, WorkflowTaskRepository } from "../storage/database.js";
import { RunCoordinator, executeRegisteredWorkflow, WorkflowExecutionService } from "../runtime/index.js";
import { NodeRegistry } from "../workflow-sdk/index.js";
import { pathToFileURL } from "node:url";
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
  const events = new EventRepository(storage);
  const coordinator = new RunCoordinator(runs);
  const nodes = new NodeRegistry();
  const workflowExecution = new WorkflowExecutionService(storage, nodes);
  const submitRun = (runId: string): void => {
    void coordinator.submit(runId, async (run, signal) => {
      const version = workflows.getVersion(run.workflowVersionId);
      if (!version) throw new Error("WORKFLOW_VERSION_NOT_FOUND");
      const input = run.inputRef === undefined ? null : JSON.parse(run.inputRef);
      const manifest = version.manifest as Record<string, unknown>;
      if (typeof manifest.artifactPath === "string") {
        await executeRegisteredWorkflow(storage.dataDir, { appId: "orchard", workflowId: version.workflowId, versionId: version.id, artifactPath: manifest.artifactPath, manifest: manifest as never, input }, { runId: run.id, signal, step: async () => { throw new Error("Worker step execution is not configured"); }, invokeTool: async () => { throw new Error("Worker tool execution is not configured"); } });
      } else {
        const bundlePath = resolve(storage.dataDir, version.bundlePath);
        const loaded = await import(pathToFileURL(bundlePath).href);
        const candidate = loaded.default ?? loaded.workflow ?? loaded.run;
        if (typeof candidate === "function") {
          await candidate({ runId: run.id, signal, step: async () => { throw new Error("Worker step execution is not configured"); }, invokeTool: async () => { throw new Error("Worker tool execution is not configured"); } }, input);
        } else if (candidate && typeof candidate.run === "function") {
          await workflowExecution.execute(run.id, candidate, input, signal);
        } else { 
          throw new Error("Workflow bundle does not export a workflow");
        }
      }
      return {};
    }).catch(() => { /* RunCoordinator records failed state; the API exposes it via polling. */ });
  };
  // Runs are durable. Resume queued work after a process restart instead of
  // leaving it visible in the UI forever with no in-memory queue entry.
  for (const run of runs.listRuns(100, 0)) if (run.status === "queued") submitRun(run.id);
  const readTree = async (root: string, prefix: string): Promise<Record<string, Buffer>> => { const result: Record<string, Buffer> = {}; for (const entry of await readdir(root, { withFileTypes: true })) { const source = join(root, entry.name); const name = prefix ? `${prefix}/${entry.name}` : entry.name; if (entry.isDirectory()) Object.assign(result, await readTree(source, name)); else result[name] = await readFile(source); } return result; };
  const app = createServer({
    authority,
    listWorkflows: (limit, offset) => workflows.listWorkflows(workspaceId, limit, offset),
    listRuns: (limit, offset) => runs.listRuns(limit, offset),
    getRun: (id) => runs.getRun(id),
    listRunEvents: (id) => runs.listEvents(id),
    listWorkflowVersions: (workflowId) => workflows.listVersions(workflowId),
    createDraft: (input) => workflows.createDraft({ workspaceId, rootPath: `${storage.dataDir}/workspaces/default`, ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}) }),
    getDraft: (id) => workflows.getDraft(id),
    listTasks: (runId) => tasks.list(runId),
    getTask: (id) => tasks.get(id),
    listSchedules: () => schedules.list(),
    createSchedule: (input) => schedules.create(input),
    setScheduleEnabled: (id, enabled) => schedules.setEnabled(id, enabled),
    createWorkflow: (input) => workflows.createWorkflow({ workspaceId, ...input }),
    listDiscoveredWorkflows: async () => {
      const candidates = await discoverWorkflows(join(storage.dataDir, "workspaces"));
      return candidates.map((candidate) => {
        const targetWorkspace = workflows.getWorkspaceByName(candidate.workspace);
        const existing = targetWorkspace ? workflows.getWorkflow(candidate.id, targetWorkspace.id) : undefined;
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
    exportWorkflow: async (workflowId) => { const versionId = workflows.getCurrentVersionId(workflowId); if (!versionId) throw new Error("Workflow has no published version"); const version = workflows.getVersion(versionId); if (!version) throw new Error("Workflow version not found"); const root = resolve(storage.dataDir, version.sourcePath); const files = await readTree(root, "source"); const bundle = resolve(storage.dataDir, version.bundlePath); try { Object.assign(files, await readTree(bundle, "bundle")); } catch { /* source-only legacy versions */ } return createWorkflowExport({ app: { id: "orchard", name: "Orchard" }, workflow: { id: workflowId }, version: { id: version.id, number: version.versionNo, manifest: version.manifest }, files }); },
    importWorkflow: async (body) => { const pkg = validateWorkflowExport(body); const workflow = workflows.createWorkflow({ id: pkg.workflow.id, workspaceId, name: pkg.workflow.name ?? pkg.workflow.id }); const published = await publishWorkflowImport({ instanceRoot: storage.dataDir, pkg, persist: ({ sourcePath, bundlePath }) => { workflows.createVersion({ id: pkg.version.id, workflowId: workflow.id, contentHash: pkg.version.id, sourcePath, bundlePath: bundlePath ?? `${sourcePath}/../bundle/worker.mjs`, manifest: pkg.version.manifest, sdkVersion: "0.1.0" }); } }); return { workflowId: workflow.id, versionId: pkg.version.id, artifactPath: published.artifactPath }; },
    publishWorkflow: (workflowId, entry) => publishWorkflow({ workflows, workflowId, rootDir: `${storage.dataDir}/workspaces/default`, entry, outputDir: `${storage.dataDir}/versions/${workflowId}` }),
    createRun: (workflowId, input, idempotencyKey) => {
      const workflowVersionId = workflows.getCurrentVersionId(workflowId);
      if (!workflowVersionId) throw new Error("WORKFLOW_NOT_FOUND");
      const inputRef = JSON.stringify(input === undefined ? null : input);
      const run = runs.createRun({ workflowVersionId, inputRef, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
      submitRun(run.id);
      return run;
    },
    cancelRun: (id, reason) => coordinator.cancel(id, reason),
    receiveEvent: (input) => events.receive(input),
  });
  try {
    const address = await app.listen({ host: options.host, port });
    process.stdout.write(`Orchard listening at ${address}\n`);
    process.stdout.write(`Data directory: ${storage.dataDir}\n`);
    if (options.open) openBrowser(address);
  } catch (error) {
    storage.close();
    throw error;
  }
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
    coordinator.close();
    await app.close();
    storage.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

async function doctor(): Promise<void> {
  process.stdout.write(`Node.js: ${process.version}\n`);
  process.stdout.write(`Platform: ${process.platform}\n`);
  process.stdout.write("HTTP server: available\n");
  process.stdout.write("Persistence: SQLite schema available\n");
  process.stdout.write("Pi: not configured\n");
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

program.command("doctor").description("Check the local Orchard environment").action(doctor);

await program.parseAsync(process.argv);
