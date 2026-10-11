import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { initializeDatabase, createDefaultWorkspace, WorkflowRepository } from "../../dist/storage/database.js";
import { materializeFakeClis } from "../helpers/fake-cli.mjs";

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error("Timed out waiting for the orchard server");
}

test("ai.pi node and Pi authoring run end-to-end through the fake host CLI", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orchard-e2e-hostcli-"));
  const { pi, codex } = await materializeFakeClis(join(dir, "bin"));
  await mkdir(join(dir), { recursive: true });
  // Trusted registration via settings: the fake pi is the operator's choice.
  await writeFile(join(dir, "settings.json"), `${JSON.stringify({ cli: { "pi-cli": { executable: pi } } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  // The workflow bundle embeds the agent profile id; everything is created
  // before the server starts because the instance lock is exclusive.
  const db = initializeDatabase(dir);
  const workspaceId = createDefaultWorkspace(db);
  const workflowId = "host-cli-e2e";
  const repositories = new WorkflowRepository(db);
  repositories.createWorkflow({ id: workflowId, workspaceId, name: "Host CLI e2e" });
  const agent = new (await import("../../dist/storage/database.js")).AgentProfileRepository(db).create({ name: "e2e-helper", provider: "pi-cli", model: "" });
  const fixture = `export default async function run(ctx) {\n  const result = await ctx.step("ai-step", { type: "ai.pi", config: { agentProfileId: ${JSON.stringify(agent.id)}, outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } }, input: { prompt: 'RETURN:{"answer":"e2e"}' } });\n  return result.output;\n}\n`;
  await writeFile(join(dir, "worker.mjs"), fixture, { encoding: "utf8", mode: 0o600 });
  repositories.createVersion({ workflowId, contentHash: "e2e", sourcePath: "worker.mjs", bundlePath: "worker.mjs", manifest: {}, sdkVersion: "test" });
  db.close();

  const portServer = createServer(); portServer.listen(0, "127.0.0.1"); await once(portServer, "listening");
  const port = portServer.address().port; await new Promise((resolve) => portServer.close(resolve));
  const url = `http://127.0.0.1:${port}`;

  let child;
  let output = "";
  const start = async () => {
    output = "";
    child = spawn(process.execPath, ["dist/cli/main.js", "start", "--port", String(port), "--data-dir", dir], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    await until(() => { if (child.exitCode !== null) throw new Error(output); return output.includes("Orchard listening") && output.includes("CLI backend pi-cli:"); });
  };
  const stop = async () => { if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  await start();
  assert.match(output, /CLI backend pi-cli: .+\/bin\/pi \(settings\)/);

  const json = async (path, method, body) => {
    const response = await fetch(`${url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(value)}`);
    return value;
  };

  // 1. Run the workflow; the ai.pi step executes through the fake CLI.
  const run = await json(`/api/workflows/${workflowId}/runs`, "POST", {});
  const finished = await until(async () => {
    const current = await json(`/api/runs/${run.id}`, "GET");
    if (current.status === "failed") {
      const events = await json(`/api/runs/${run.id}/events`, "GET");
      throw new Error(`run failed: ${JSON.stringify(events)}\nserver output:\n${output}`);
    }
    return current.status === "succeeded" ? current : null;
  });
  assert.equal(finished.status, "succeeded");

  // The step attempt is locatable in run history.
  const trace = await json(`/api/runs/${run.id}/trace`, "GET");
  const traceText = JSON.stringify(trace);
  assert.match(traceText, /ai-step/);
  assert.match(traceText, /step\.succeeded/);

  // 3. Pi authoring: draft -> author -> patch lands on disk.
  const scaffold = await json("/api/workflows", "POST", { name: "Authored workflow" });
  const draftResponse = await fetch(`${url}/api/workflows/${scaffold.id}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!draftResponse.ok) throw new Error(`drafts -> ${draftResponse.status}`);
  const draftId = (await draftResponse.text()).replace(/^"|"$/g, "");
  const authored = await json(`/api/drafts/${draftId}/author`, "POST", { prompt: 'RETURN:{"summary":"scaffold updated","patches":[{"path":"worker.ts","content":"export const authored = true;\\n"}]}' });
  assert.equal(authored.summary, "scaffold updated");
  const patched = await readFile(join(dir, "workspaces", "default", "drafts", draftId, "worker.ts"), "utf8");
  assert.match(patched, /authored = true/);

  // 4. Settings PUT wiring: relative paths are rejected, absolute paths are
  // probed and pinned, and clearing falls back to discovery.
  const relative = await fetch(`${url}/api/settings/cli-backends/pi-cli`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "bin/pi" }) });
  assert.equal(relative.status, 400);
  assert.match((await relative.json()).message, /absolute/);

  const pinned = await json("/api/settings/cli-backends/codex-cli", "PUT", { path: codex });
  assert.equal(pinned.available, true);
  assert.equal(pinned.source, "settings");
  const afterPin = await json("/api/settings/cli-backends", "GET");
  const codexItem = afterPin.items.find((item) => item.launcher === "codex-cli");
  assert.equal(codexItem.source, "settings");
  assert.equal(codexItem.path, codex);

  const cleared = await json("/api/settings/cli-backends/codex-cli", "PUT", { path: "" });
  assert.notEqual(cleared.source, "settings"); // falls back to discovery (host-dependent)
});
