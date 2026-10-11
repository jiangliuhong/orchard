import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalNodeRegistry } from "../dist/runtime/local-nodes.js";
import { CliBackendRegistry, CliPiClient } from "../dist/integrations/pi/index.js";

// A fake pi executable: reads the prompt from stdin and echoes everything
// after the "RETURN:" marker as the final assistant message (pi JSONL shape).
const FAKE_PI = `#!/usr/bin/env node
let data = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) data += chunk;
const marker = "RETURN:";
const text = data.startsWith(marker) ? data.slice(marker.length) : data;
const line = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
line({ type: "session", version: 3, id: "fake" });
line({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "fake-pi", model: "fake-model", usage: { input: 1, output: 2, totalTokens: 3 } } });
line({ type: "agent_settled", aborted: false });
`;

async function fakePiBackend() {
  const dir = await mkdtemp(join(tmpdir(), "orchard-aipi-"));
  const executable = join(dir, "pi");
  await writeFile(executable, FAKE_PI, { encoding: "utf8", mode: 0o755 });
  await chmod(executable, 0o755);
  const registry = new CliBackendRegistry();
  registry.set("pi-cli", { executable, source: "discovered", defaultTimeoutMs: 10_000, maxOutputBytes: 1024 * 1024, killGraceMs: 500 });
  return { registry, dir };
}

function agentsRepo(profiles) {
  return { list: () => profiles };
}

const CONTEXT = { runId: "r", stepId: "s", attemptId: "a", signal: new AbortController().signal, log: () => {} };

test("ai.pi executes through a valid profile and passes schema validation", async () => {
  const { registry, dir } = await fakePiBackend();
  try {
    const profiles = [{ id: "agent-1", name: "helper", provider: "pi-cli", model: "", config: {}, allowedTools: [] }];
    const nodes = createLocalNodeRegistry({ agents: agentsRepo(profiles), client: new CliPiClient({ registry, workspaceRoot: dir }) });
    const output = await nodes.get("ai.pi").execute(
      CONTEXT,
      { agentProfileId: "agent-1", outputSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } }, additionalProperties: false } },
      { prompt: 'RETURN:{"answer":"42"}' },
    );
    assert.deepEqual(output.output, { answer: "42" });
    assert.equal(output.provider, "fake-pi");
    assert.equal(output.model, "fake-model");
    assert.deepEqual(output.usage, { input: 1, output: 2, totalTokens: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ai.pi reports configuration errors as non-retryable", async () => {
  const { registry, dir } = await fakePiBackend();
  try {
    const profiles = [
      { id: "legacy", name: "old", provider: "openai", model: "gpt-4o", config: {}, allowedTools: [] },
    ];
    const nodes = createLocalNodeRegistry({ agents: agentsRepo(profiles), client: new CliPiClient({ registry, workspaceRoot: dir }) });
    const node = nodes.get("ai.pi");

    await assert.rejects(
      node.execute(CONTEXT, { agentProfileId: "missing" }, { prompt: "hi" }),
      (error) => error.code === "AGENT_PROFILE_NOT_FOUND" && error.retryable === false,
    );
    await assert.rejects(
      node.execute(CONTEXT, { agentProfileId: "legacy" }, { prompt: "hi" }),
      (error) => error.code === "INVALID_AGENT_PROFILE" && error.retryable === false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ai.pi fails retryably when the backend launcher is unresolved or output violates the schema", async () => {
  const { registry, dir } = await fakePiBackend();
  try {
    const profiles = [{ id: "codex-1", name: "c", provider: "codex-cli", model: "", config: {}, allowedTools: [] }];
    const nodes = createLocalNodeRegistry({ agents: agentsRepo(profiles), client: new CliPiClient({ registry, workspaceRoot: dir }) });
    await assert.rejects(
      nodes.get("ai.pi").execute(CONTEXT, { agentProfileId: "codex-1" }, { prompt: "hi" }),
      (error) => error.code === "AGENT_BACKEND_NOT_CONFIGURED" && error.retryable === false,
    );

    const piProfiles = [{ id: "agent-1", name: "helper", provider: "pi-cli", model: "", config: {}, allowedTools: [] }];
    const withPi = createLocalNodeRegistry({ agents: agentsRepo(piProfiles), client: new CliPiClient({ registry, workspaceRoot: dir }) });
    // Non-JSON output under a declared schema -> INVALID_PI_OUTPUT (retryable).
    await assert.rejects(
      withPi.get("ai.pi").execute(
        CONTEXT,
        { agentProfileId: "agent-1", outputSchema: { type: "object" } },
        { prompt: "RETURN:not-json" },
      ),
      (error) => error.code === "INVALID_PI_OUTPUT" && error.retryable !== false,
    );
    // Valid JSON violating the schema -> assertValidJson error (default retryable).
    await assert.rejects(
      withPi.get("ai.pi").execute(
        CONTEXT,
        { agentProfileId: "agent-1", outputSchema: { type: "object", required: ["answer"], additionalProperties: false } },
        { prompt: 'RETURN:{"wrong":true}' },
      ),
      (error) => error.retryable === undefined && /validation failed/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
