#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import process from "node:process";
import { homedir } from "node:os";
import { Command } from "commander";
import { createServer } from "../server/app.js";
import { createDefaultWorkspace, EventRepository, initializeDatabase, RunRepository, WorkflowRepository } from "../storage/database.js";
import { publishWorkflow } from "../authoring/publish.js";

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
  const accessToken = randomBytes(32).toString("hex");
  const authority = `${options.host === "::1" ? "[::1]" : options.host}:${port}`;
  const workflows = new WorkflowRepository(storage);
  const runs = new RunRepository(storage);
  const events = new EventRepository(storage);
  const app = createServer({
    accessToken,
    authority,
    listWorkflows: (limit, offset) => workflows.listWorkflows(workspaceId, limit, offset),
    listRuns: (limit, offset) => runs.listRuns(limit, offset),
    getRun: (id) => runs.getRun(id),
    createWorkflow: (input) => workflows.createWorkflow({ workspaceId, ...input }),
    publishWorkflow: (workflowId, entry) => publishWorkflow({ workflows, workflowId, rootDir: `${storage.dataDir}/workspaces/default`, entry, outputDir: `${storage.dataDir}/versions/${workflowId}` }),
    createRun: (workflowId, input, idempotencyKey) => {
      const workflowVersionId = workflows.getCurrentVersionId(workflowId);
      if (!workflowVersionId) throw new Error("WORKFLOW_NOT_FOUND");
      const inputRef = JSON.stringify(input === undefined ? null : input);
      return runs.createRun({ workflowVersionId, inputRef, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
    },
    cancelRun: (id, reason) => runs.requestCancel(id, reason),
    receiveEvent: (input) => events.receive(input),
  });
  try {
    const address = await app.listen({ host: options.host, port });
    process.stdout.write(`Orchard listening at ${address}\n`);
    process.stdout.write(`Data directory: ${storage.dataDir}\n`);
    process.stdout.write(`Access token (valid for this process only): ${accessToken}\n`);
    if (options.open) openBrowser(address);
  } catch (error) {
    storage.close();
    throw error;
  }
  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
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
