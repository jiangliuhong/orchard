import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CliBackendRegistry, CliPiClient } from "../dist/integrations/pi/index.js";
import { CliExecutionError } from "../dist/integrations/cli/index.js";
import { materializeFakeClis } from "./helpers/fake-cli.mjs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orchard-cli-int-"));
  const { pi, codex } = await materializeFakeClis(join(root, "bin"));
  const registry = new CliBackendRegistry();
  registry.set("pi-cli", { executable: pi, source: "settings", defaultTimeoutMs: 5_000, maxOutputBytes: 1024 * 1024, killGraceMs: 300 });
  registry.set("codex-cli", { executable: codex, source: "settings", defaultTimeoutMs: 5_000, maxOutputBytes: 1024 * 1024, killGraceMs: 300 });
  const client = new CliPiClient({ registry, workspaceRoot: root });
  const controller = new AbortController();
  return { root, client, controller, registry, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function runPi(client, prompt, options = {}, overrides = {}) {
  const session = await client.forLauncher("pi-cli", overrides).createSession({ signal: new AbortController().signal, allowedTools: [] });
  return session.run({ prompt, allowedTools: [], ...options });
}

test("CliPiClient pipes the prompt via stdin and returns parsed output with metadata", async () => {
  const { client, cleanup } = await setup();
  try {
    const result = await runPi(client, 'RETURN:{"answer":"ok"}', { outputSchema: { type: "object", required: ["answer"] } });
    assert.deepEqual(result.output, { answer: "ok" });
    assert.equal(result.provider, "fake-pi");
    assert.equal(result.model, "fake-default-model");
    assert.deepEqual(result.usage, { input: 10, output: 5, totalTokens: 15, costTotal: 0.0001 });

    const pinned = await runPi(client, "RETURN:plain text", {}, { model: "pinned-model" });
    assert.equal(pinned.model, "pinned-model"); // --model passthrough, echoed by the fake
    assert.equal(pinned.output, "plain text"); // no schema -> raw text
  } finally {
    await cleanup();
  }
});

test("CliPiClient surfaces non-zero exits with stderr and stays retryable", async () => {
  const { client, cleanup } = await setup();
  try {
    await assert.rejects(
      runPi(client, "FAIL:credentials rejected (403)"),
      (error) => error.code === "CLI_PROCESS_FAILED" && error.retryable === true && error.exitCode === 1 && /credentials rejected/.test(error.stderr),
    );
  } finally {
    await cleanup();
  }
});

test("CliPiClient maps controller timeout and cancellation to the process-control codes", async () => {
  const { client, cleanup, registry } = await setup();
  try {
    registry.set("pi-cli", { executable: registry.get("pi-cli").executable, source: "settings", defaultTimeoutMs: 250, maxOutputBytes: 1024 * 1024, killGraceMs: 200 });
    await assert.rejects(
      runPi(client, "HANG"),
      (error) => error instanceof CliExecutionError && error.code === "PROCESS_TIMEOUT",
    );

    const controller = new AbortController();
    const session = await client.forLauncher("pi-cli").createSession({ signal: controller.signal, allowedTools: [] });
    const pending = session.run({ prompt: "HANG", allowedTools: [] });
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof CliExecutionError && error.code === "PROCESS_CANCELLED",
    );
  } finally {
    await cleanup();
  }
});

test("CliPiClient reads the codex final message from -o, enforces the sandbox sentinel and cleans up", async () => {
  const { root, client, cleanup } = await setup();
  const tmpBefore = (await readdir(tmpdir())).filter((name) => name.startsWith("orchard-codex-")).length;
  try {
    const session = await client.forLauncher("codex-cli").createSession({ signal: new AbortController().signal, allowedTools: [] });
    const result = await session.run({ prompt: "RETURN:codex says hi", allowedTools: [] });
    assert.equal(result.output, "codex says hi");
    assert.equal(result.provider, "codex");
    assert.equal(result.model, "fake-codex-model"); // from the event stream, not the fallback
    assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });

    // read-only default denies writes requested through the prompt...
    await assert.rejects(
      session.run({ prompt: "NEED-WRITE RETURN:x", allowedTools: [] }),
      (error) => error.code === "CLI_PROCESS_FAILED" && error.exitCode === 2 && /denies the requested write/.test(error.stderr),
    );
    // ...and the workspace-write sentinel authorizes it.
    const write = await client.forLauncher("codex-cli").createSession({ signal: new AbortController().signal, allowedTools: ["workspace-write"] });
    const written = await write.run({ prompt: "NEED-WRITE RETURN:wrote", allowedTools: ["workspace-write"] });
    assert.equal(written.output, "wrote");

    const tmpAfter = (await readdir(tmpdir())).filter((name) => name.startsWith("orchard-codex-")).length;
    assert.equal(tmpAfter, tmpBefore, "codex temp dirs must be removed after runs");
    void root;
  } finally {
    await cleanup();
  }
});
