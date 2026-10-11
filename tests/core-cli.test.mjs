import assert from "node:assert/strict";
import { execPath } from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CliExecutionError,
  CliToolRegistry,
  CoreCliExecutor,
  ProcessController,
} from "../dist/integrations/cli/index.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-fixture.mjs");
const tool = (mode, options = {}) => ({
  id: `fixture.${mode}`,
  version: "1",
  executable: execPath,
  sideEffects: "read_only",
  buildArgs: (input) => [fixture, mode, String(input ?? "")],
  ...options,
});

function setup() {
  const registry = new CliToolRegistry();
  const executor = new CoreCliExecutor(registry);
  return { registry, executor };
}

test("core.cli executes a registered tool without accepting an executable from input", async () => {
  const { registry, executor } = setup();
  registry.register(tool("ok", {
    id: "fixture.json",
    parseOutput: (result) => JSON.parse(result.stdout),
  }));

  const logs = [];
  const result = await executor.execute({ onLog: (event) => logs.push(event) }, { toolId: "fixture.json" }, "hello");

  assert.deepEqual(result.output, { value: "hello" });
  assert.equal(result.process.exitCode, 0);
  assert.equal(result.toolId, "fixture.json");
  assert.ok(logs.some((event) => event.stream === "stdout"));
});

test("core.cli preserves stderr and rejects non-zero exit codes", async () => {
  const { registry, executor } = setup();
  registry.register(tool("fail", { id: "fixture.fail" }));

  await assert.rejects(
    executor.execute({}, { toolId: "fixture.fail" }, ""),
    (error) => {
      assert.ok(error instanceof CliExecutionError);
      assert.equal(error.code, "PROCESS_FAILED");
      assert.equal(error.details.exitCode, 7);
      assert.match(String(error.details.stderr), /fixture failed/);
      return true;
    },
  );
});

test("core.cli enforces a timeout and supports cancellation", async () => {
  const { registry, executor } = setup();
  registry.register(tool("sleep", { id: "fixture.sleep", killGraceMs: 100 }));

  await assert.rejects(
    executor.execute({}, { toolId: "fixture.sleep", timeoutMs: 50 }, 5000),
    (error) => error instanceof CliExecutionError && error.code === "PROCESS_TIMEOUT",
  );

  const controller = new AbortController();
  const pending = executor.execute({ signal: controller.signal }, { toolId: "fixture.sleep" }, 5000);
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof CliExecutionError && error.code === "PROCESS_CANCELLED",
  );
});

test("core.cli stops a tool that exceeds the combined stdout/stderr limit", async () => {
  const { registry, executor } = setup();
  registry.register(tool("spam", { id: "fixture.spam", killGraceMs: 100 }));

  await assert.rejects(
    executor.execute({}, { toolId: "fixture.spam", maxOutputBytes: 1024 }, 2_000_000),
    (error) => error instanceof CliExecutionError && error.code === "OUTPUT_LIMIT_EXCEEDED",
  );
});

test("registry rejects duplicates and unknown tools", async () => {
  const { registry, executor } = setup();
  registry.register(tool("ok", { id: "fixture.duplicate" }));
  assert.throws(() => registry.register(tool("ok", { id: "fixture.duplicate" })), /already registered/);
  await assert.rejects(
    executor.execute({}, { toolId: "fixture.unknown" }, ""),
    (error) => error instanceof CliExecutionError && error.code === "TOOL_NOT_FOUND",
  );
});

test("process controller pipes stdin payloads to the child", async () => {
  const controller = new ProcessController();
  const result = await controller.execute({
    executable: execPath,
    args: [fixture, "stdin-echo"],
    stdin: "hello stdin",
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    killGraceMs: 100,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello stdin");
});

test("process controller ignores EPIPE when the child exits before reading stdin", async () => {
  const controller = new ProcessController();
  const result = await controller.execute({
    executable: execPath,
    args: [fixture, "stdin-exit-early"],
    stdin: "payload nobody reads",
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    killGraceMs: 100,
  });
  // The EPIPE from the undrained stdin write must not surface as a crash; the
  // failure is reported through the ordinary exit code / stderr path.
  assert.equal(result.exitCode, 9);
  assert.match(result.stderr, /early exit before stdin/);
});

test("process controller keeps ignore-stdio behaviour when no stdin is supplied", async () => {
  const controller = new ProcessController();
  const result = await controller.execute({
    executable: execPath,
    args: [fixture, "ok", "plain"],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    killGraceMs: 100,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { value: "plain" });
});

