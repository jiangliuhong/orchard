import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PiCliError,
  buildCodexArgs,
  buildPiArgs,
  codexSandboxFromTools,
  parseCodexJsonl,
  parsePiJsonl,
} from "../dist/integrations/pi/cli-client.js";

test("buildPiArgs defaults to no tools, default model and thinking off", () => {
  assert.deepEqual(buildPiArgs({}), [
    "-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp",
    "--no-tools", "--thinking", "off",
  ]);
});

test("buildPiArgs maps allowlists, explicit models and thinking levels", () => {
  assert.deepEqual(buildPiArgs({ allowedTools: ["read", "bash"], model: "anthropic/claude", thinkingLevel: "high" }), [
    "-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp",
    "--tools", "read,bash", "--model", "anthropic/claude", "--thinking", "high",
  ]);
  // An empty allowlist is "no tools", and an empty model means the CLI default.
  assert.deepEqual(buildPiArgs({ allowedTools: [], model: "" }), [
    "-p", "--mode", "json", "--no-session", "--no-extensions", "--no-mcp",
    "--no-tools", "--thinking", "off",
  ]);
});

test("buildCodexArgs pins the sandbox and output file; danger-full-access is not expressible", () => {
  assert.deepEqual(buildCodexArgs({ sandbox: "read-only", outputFile: "/tmp/out.txt" }), [
    "exec", "--json", "-s", "read-only", "-o", "/tmp/out.txt",
  ]);
  assert.deepEqual(buildCodexArgs({ sandbox: "workspace-write", model: "gpt-5", outputFile: "/tmp/out.txt" }), [
    "exec", "--json", "-m", "gpt-5", "-s", "workspace-write", "-o", "/tmp/out.txt",
  ]);
  assert.equal(codexSandboxFromTools([]), "read-only");
  assert.equal(codexSandboxFromTools(["workspace-write"]), "workspace-write");
});

const PI_JSONL = [
  JSON.stringify({ type: "session", version: 3, id: "s1" }),
  JSON.stringify({ type: "agent_start" }),
  JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "draft" }], provider: "pi", model: "m-old", usage: { input: 1 } } }),
  "{ not json at all",
  JSON.stringify({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "ignored" },
        { type: "text", text: "{\"summary\":" },
        { type: "text", text: "\"ok\"}" },
      ],
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      usage: { input: 519, output: 5, totalTokens: 524, cost: { total: 0.00108 } },
    },
  }),
  JSON.stringify({ type: "agent_settled", aborted: false }),
].join("\n");

test("parsePiJsonl keeps the last assistant turn_end and joins text blocks", () => {
  const turn = parsePiJsonl(PI_JSONL);
  assert.equal(turn.text, '{"summary":"ok"}');
  assert.equal(turn.provider, "openai-codex");
  assert.equal(turn.model, "gpt-6.1-sol");
  assert.deepEqual(turn.usage, { input: 519, output: 5, totalTokens: 524, costTotal: 0.00108 });
});

test("parsePiJsonl fails on error events and missing assistant turns", () => {
  assert.throws(
    () => parsePiJsonl([JSON.stringify({ type: "error", error: { message: "provider 403" } })].join("\n")),
    (error) => error instanceof PiCliError && error.code === "CLI_PROCESS_FAILED" && /provider 403/.test(error.message),
  );
  assert.throws(
    () => parsePiJsonl([JSON.stringify({ type: "agent_settled" })].join("\n")),
    (error) => error instanceof PiCliError && error.code === "INVALID_PI_OUTPUT" && /no final assistant message/.test(error.message),
  );
  assert.throws(
    () => parsePiJsonl("{ broken\n{ also broken\n"),
    (error) => error instanceof PiCliError && error.code === "INVALID_PI_OUTPUT" && /could not be parsed/.test(error.message),
  );
  assert.throws(() => parsePiJsonl(""), (error) => error instanceof PiCliError && error.code === "INVALID_PI_OUTPUT");
});

test("parseCodexJsonl extracts turn.completed usage and tolerates noise", () => {
  const stream = [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "turn.started", model: "gpt-5-codex" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    "garbage line",
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }),
  ].join("\n");
  assert.deepEqual(parseCodexJsonl(stream).usage, { input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  assert.equal(parseCodexJsonl(stream).model, "gpt-5-codex");
  assert.deepEqual(parseCodexJsonl(""), {});
});

test("PiCliError carries code, retryability and process details", () => {
  const error = new PiCliError("CLI_PROCESS_FAILED", "boom", { retryable: true, stderr: "403 denied", exitCode: 1 });
  assert.equal(error.code, "CLI_PROCESS_FAILED");
  assert.equal(error.retryable, true);
  assert.equal(error.stderr, "403 denied");
  assert.equal(error.exitCode, 1);
  const fatal = new PiCliError("AGENT_BACKEND_NOT_CONFIGURED", "nope", { retryable: false });
  assert.equal(fatal.retryable, false);
});
