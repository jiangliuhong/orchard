#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("fixture-cli 1.0"); process.exit(0); }
if (args.includes("--list-models")) { console.log("provider model context\nfixture small 128000"); process.exit(0); }
let prompt = ""; for await (const chunk of process.stdin) prompt += chunk;
if (prompt.includes("HANG")) { setInterval(() => {}, 1000); } else {
  if (prompt.includes("FAIL")) { console.error("fixture authentication error"); process.exit(3); }
  const text = prompt.startsWith("CONFIG-CHECK") ? JSON.stringify({ args, home: process.env.CODEX_HOME })
    : prompt.includes("LARGE-FINAL") ? "x".repeat(9 * 1024 * 1024) : prompt.match(/^RETURN:(.*)$/m)?.[1] ?? '{"answer":42}';
  if (args[0] === "exec") {
    writeFileSync(args[args.indexOf("-o") + 1], text);
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4, output_tokens: 3 } }));
  } else {
    console.log(JSON.stringify({ type: "session", id: "fixture" }));
    console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello\u2028world" } }));
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: args[args.indexOf("--model") + 1], content: [{ type: "text", text }], usage: { input: 4, output: 3 } } }));
    console.log(JSON.stringify({ type: "agent_settled", aborted: false }));
  }
}
