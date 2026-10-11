#!/usr/bin/env node
// Fake codex CLI for tests. Reads the prompt from stdin, writes the final
// agent message to the `-o <file>` path, and emits a `--json` event stream.
// Protocol markers: RETURN:<text> / FAIL:<msg> / HANG (see fake-pi.mjs), plus
// NEED-WRITE in the prompt to require the workspace-write sandbox.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-fake 0.16.0\n");
  process.exit(0);
}

const outputFlag = process.argv.indexOf("-o");
const modelFlag = process.argv.indexOf("-m");
const sandboxFlag = process.argv.indexOf("-s");
const outputFile = outputFlag !== -1 ? process.argv[outputFlag + 1] : undefined;
const model = modelFlag !== -1 ? process.argv[modelFlag + 1] : "fake-codex-model";

let data = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) data += chunk;
if (data.startsWith("FAIL:")) {
  process.stderr.write(`${data.slice(5)}\n`);
  process.exit(1);
}
if (data.startsWith("HANG")) {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
const marker = data.indexOf("RETURN:");
const text = marker !== -1 ? data.slice(marker + "RETURN:".length) : data;
const sandbox = sandboxFlag !== -1 ? process.argv[sandboxFlag + 1] : "(none)";
if (data.includes("NEED-WRITE") && sandbox !== "workspace-write") {
  process.stderr.write(`sandbox ${sandbox} denies the requested write\n`);
  process.exit(2);
}
if (!outputFile) {
  process.stderr.write("missing -o output file\n");
  process.exit(3);
}
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, text, "utf8");
const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
line({ type: "thread.started", thread_id: "fake-thread" });
line({ type: "turn.started", model });
line({ type: "item.completed", item: { type: "agent_message", text } });
line({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
