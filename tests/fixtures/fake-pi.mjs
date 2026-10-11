#!/usr/bin/env node
// Fake pi CLI for tests. Protocol markers in the stdin prompt control behaviour:
//   RETURN:<text>  emit <text> as the final assistant message (JSONL stream)
//   FAIL:<msg>     exit 1 with <msg> on stderr
//   HANG           never reply (timeout / cancellation tests)
let data = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) data += chunk;
if (process.argv.includes("--version")) {
  process.stdout.write("pi-fake 1.1.0\n");
  process.exit(0);
}
if (data.startsWith("FAIL:")) {
  process.stderr.write(`${data.slice(5)}\n`);
  process.exit(1);
}
if (data.startsWith("HANG")) {
  // A bare pending promise would trip Node's "unsettled top-level await"
  // detection; keep the loop genuinely busy instead.
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}
const text = data.startsWith("RETURN:") ? data.slice(7) : data;
const modelFlag = process.argv.indexOf("--model");
const model = modelFlag !== -1 ? process.argv[modelFlag + 1] : "fake-default-model";
const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
line({ type: "session", version: 3, id: "fake-session" });
line({ type: "agent_start" });
line({ type: "turn_start" });
line({ type: "message_update", usage: { input: 0 }, assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
line({
  type: "turn_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "fake-pi",
    model,
    usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.0001 } },
    stopReason: "stop",
  },
  toolResults: [],
});
line({ type: "agent_end", messages: [] });
line({ type: "agent_settled", aborted: false });
