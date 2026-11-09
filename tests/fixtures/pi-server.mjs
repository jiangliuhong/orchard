#!/usr/bin/env node
// Fake `pi --mode rpc` for contract tests (设计文档 §24).
// 场景通过 PI_FIXTURE_SCENARIO 选择；收到的每行 stdin 记录到 PI_FIXTURE_LOG（JSONL，
// 首两行为 pid 与 argv），用于断言启动参数、clear_queue→abort 顺序与多轮同进程。
import { appendFileSync } from "node:fs";

const scenario = process.env.PI_FIXTURE_SCENARIO ?? "default";
const logPath = process.env.PI_FIXTURE_LOG;
const slowMs = Number(process.env.PI_SLOW_MS ?? 0);
const recordIn = line => { if (logPath) appendFileSync(logPath, line + "\n"); };
const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");

if (process.argv.includes("--version")) { process.stdout.write("pi 1.3.0 (fixture)\n"); process.exit(0); }
if (!process.argv.includes("rpc")) { process.stderr.write("unexpected invocation\n"); process.exit(2); }
// 多进程追加写入同一日志：每个进程以 "pid <n>" + argv 头开始。
if (logPath) appendFileSync(logPath, `pid ${process.pid}\n${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
if (scenario === "ignore-stdin") { setInterval(() => {}, 1000); }

const args = process.argv.slice(2);
const modelFlag = args[args.indexOf("--model") + 1] ?? "unknown-model";
let prompts = 0;
let aborted = false;

function finalAssistant(text) {
  send({ type: "message_update", assistantMessageEvent: { type: "text_start" } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(0, Math.ceil(text.length / 2)) } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text.slice(Math.ceil(text.length / 2)) } });
}

function settle(extra = {}) {
  send({ type: "agent_settled", aborted, ...extra });
}

function runReply(message) {
  prompts += 1;
  const reply = message.startsWith("RETURN:") ? message.slice(7) : JSON.stringify({ promptCount: prompts, echo: message.slice(0, 60), model: modelFlag });
  switch (scenario) {
    case "slow-settle":
      setTimeout(() => { finalAssistant(reply); send({ type: "message_end", message: { role: "assistant", model: modelFlag, content: [{ type: "text", text: reply }], usage: { input: 3, output: 4 }, stopReason: "stop" } }); settle(); }, slowMs);
      return;
    case "retry": {
      // 重试过程中的临时错误不能提前当最终错误：第一次失败，随后重试成功。
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "temporary provider hiccup" } });
      send({ type: "agent_end", messages: [], willRetry: true });
      finalAssistant(reply);
      send({ type: "message_end", message: { role: "assistant", model: modelFlag, content: [{ type: "text", text: reply }], stopReason: "stop" } });
      settle();
      return;
    }
    case "model-error":
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "provider exploded" } });
      settle();
      return;
    case "no-text":
      settle();
      return;
    case "interruptible":
      return; // 终态由 abort 命令触发
    case "never-settle":
      return;
    default:
      finalAssistant(reply);
      send({ type: "message_end", message: { role: "assistant", model: modelFlag, content: [{ type: "text", text: reply }], usage: { input: 3, output: 4 }, stopReason: "stop" } });
      settle();
  }
}

function handle(msg) {
  if (msg.type === "get_state") {
    if (scenario === "state-model-mismatch") { send({ id: msg.id, type: "response", command: "get_state", success: true, data: { model: { id: "different/model" }, sessionId: "s-fixture", isStreaming: false } }); return; }
    const sessionFile = process.env.PI_SESSION_FILE;
    send({ id: msg.id, type: "response", command: "get_state", success: true, data: { model: scenario === "state-model" ? JSON.parse(process.env.PI_STATE_MODEL) : { id: modelFlag }, sessionId: "s-fixture", isStreaming: false, ...(sessionFile ? { sessionFile } : {}), messageCount: prompts } });
    return;
  }
  if (msg.type === "prompt") {
    switch (scenario) {
      case "queued": send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "queued" } }); return;
      case "handled": send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } }); return;
      case "prompt-reject": send({ id: msg.id, type: "response", command: "prompt", success: false, error: "no model selected" }); return;
      default: send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }); runReply(msg.message ?? "");
    }
    return;
  }
  if (msg.type === "clear_queue") { send({ id: msg.id, type: "response", command: "clear_queue", success: true, data: { cleared: [] } }); return; }
  if (msg.type === "abort") {
    aborted = true;
    send({ id: msg.id, type: "response", command: "abort", success: true });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted" } });
    settle();
    return;
  }
}

if (scenario !== "ignore-stdin") {
  let pending = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      recordIn(line);
      try { handle(JSON.parse(line)); } catch { /* 非法行由客户端连接层判定 */ }
    }
  }
}
