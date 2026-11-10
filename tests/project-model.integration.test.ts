import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setup } from "./helpers.js";
import { CliProvider } from "../src/providers/registry.js";
import { piNativeAdapter } from "../src/providers/pi-rpc.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { readCodexConfig } from "../src/providers/codex-config.js";
import { SessionManager } from "../src/providers/session-manager.js";

// Opt-in model calls: disposable random fixture data only, never real source/keys or a remote push.
for (const id of ["pi-cli", "codex-cli"] as const) test(`${id}: real production adapter uses project tools and returns final schema JSON`, { skip: process.env.ORCHARD_MODEL_INTEGRATION !== "1", timeout: 120000 }, async t => {
  const { store, root, providers } = setup(t); t.after(() => store.close());
  const manager = new SessionManager(); t.after(() => manager.close());
  const executable = execFileSync("/bin/sh", ["-c", `command -v ${id === "pi-cli" ? "pi" : "codex"}`], { encoding: "utf8" }).trim();
  const modelId = id === "pi-cli" ? process.env.PROBE_PI_MODEL ?? "openai-codex/gpt-6.1-sol" : process.env.PROBE_CODEX_MODEL ?? readCodexConfig().configuredModel!;
  assert.ok(modelId, "Configure PROBE_PI_MODEL / PROBE_CODEX_MODEL before live verification");
  providers.register(new CliProvider(id, { native: id === "pi-cli" ? piNativeAdapter(manager, manager.limits) : codexNativeAdapter(manager, manager.limits) }), executable);
  providers.update(id, { enabled: true, defaultModel: modelId });
  const cwd = join(root, "project-git", "verification", id), sessionDirectory = join(root, "project-git", "verification", `${id}-session`);
  mkdirSync(cwd, { recursive: true }); mkdirSync(sessionDirectory, { recursive: true });
  const left = randomInt(1000, 9000), right = randomInt(1000, 9000);
  writeFileSync(join(cwd, "left.json"), JSON.stringify({ value: left })); writeFileSync(join(cwd, "right.json"), JSON.stringify({ value: right }));
  const result = await providers.run({ providerId: id, modelId }, {
    cwd, sessionDirectory, executionContext: "project", signal: AbortSignal.timeout(100000), timeoutMs: 100000, emit: () => {},
    prompt: "Use your native tools to execute pwd and read both left.json and right.json in the working directory. Do not use any other files, network or credentials. Return only final JSON with sum (sum of their value fields), cwd (actual pwd output), and findings (two file:line references, left.json:1 and right.json:1). Do not push or install anything.",
    schema: { type: "object", required: ["sum", "cwd", "findings"], properties: { sum: { type: "integer" }, cwd: { type: "string" }, findings: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  });
  const output = result.output as { sum: number; cwd: string; findings: string[] };
  assert.equal(output.sum, left + right); assert.equal(output.cwd, cwd); assert.deepEqual(output.findings.slice().sort(), ["left.json:1", "right.json:1"]);
  assert.ok((result.toolCallCount ?? 0) > 0, "Must observe actual completed tools, not merely model claims");
});
