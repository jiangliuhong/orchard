#!/usr/bin/env node
// Fake `codex app-server` for contract tests (设计文档 §24).
// 场景通过 CODEX_FIXTURE_SCENARIO 选择；收到的每行 stdin 记录到 CODEX_FIXTURE_LOG（JSONL，
// 首行为 "pid <pid>"），用于断言握手顺序、工具策略参数与服务端请求应答。
import { appendFileSync } from "node:fs";

const scenario = process.env.CODEX_FIXTURE_SCENARIO ?? "default";
const logPath = process.env.CODEX_FIXTURE_LOG;
const recordIn = line => { if (logPath) appendFileSync(logPath, line + "\n"); };
const send = obj => process.stdout.write(JSON.stringify(obj) + "\n");
const sendRaw = text => process.stdout.write(text);

if (process.argv.includes("--version")) { process.stdout.write("codex-cli 0.165.0 (fixture)\n"); process.exit(0); }
if (!process.argv.slice(2).includes("app-server")) { process.stderr.write("unexpected invocation\n"); process.exit(2); }
// 多进程追加写入同一日志：每个进程以 "pid <n>" + argv 头开始，便于跨进程计数断言。
if (logPath) appendFileSync(logPath, `pid ${process.pid}\n${JSON.stringify({ argv: process.argv.slice(2) })}\n`);
if (scenario === "ignore-stdin") { setInterval(() => {}, 1000); } // 不读 stdin：背压测试

const THREAD = "thread-fixture-1";
const TURN = "turn-fixture-1";
let prompts = 0;

const delta = (itemId, text, turnId = TURN, threadId = THREAD) => send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: text } });
const itemCompleted = (itemId, text) => send({ method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { id: itemId, type: "agentMessage", text } } });
const turnCompleted = (status, extra = {}) => send({ method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status, ...extra } } });
const initResult = id => send({ id, result: { userAgent: "fixture/0.165.0", codexHome: "/tmp" } });

function turnFlow(msg) {
  prompts += 1;
  const text = (msg.params?.input ?? []).map(item => item?.text ?? "").join("");
  const reply = text.startsWith("RETURN:") ? text.slice(7) : JSON.stringify({ threadId: msg.params?.threadId, promptCount: prompts, echo: text.slice(0, 60) });
  switch (scenario) {
    case "no-turn-response": return;
    case "notify-first":
      delta("m1", "early ");
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      delta("m1", "world");
      itemCompleted("m1", "early world");
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: "early world" }] });
      return;
    case "overwrite":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      delta("m1", "hel");
      delta("m1", "lo ");
      itemCompleted("m1", "hello world");
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: "hello world" }] });
      return;
    case "deltas-only":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      delta("m1", "partial ");
      delta("m1", "story");
      turnCompleted("completed", { items: [] });
      return;
    case "failed":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      turnCompleted("failed", { error: { message: "model exploded" } });
      return;
    case "interrupted":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      turnCompleted("interrupted", {});
      return;
    case "approval":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      // 分别模拟命令工具、文件工具、MCP 与审批请求：全部必须被拒绝且不悬挂。
      send({ id: 901, method: "execCommandApproval", params: { command: "rm -rf /" } });
      send({ id: 903, method: "item/fileChange/requestApproval", params: { changes: [] } });
      send({ id: 904, method: "mcpServer/elicitation/request", params: { server: "evil" } });
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: "never reached" }] });
      return;
    case "unknown-request":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      send({ id: 902, method: "attestation/generate", params: {} });
      delta("m1", "kept going");
      itemCompleted("m1", "kept going");
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: "kept going" }] });
      return;
    case "usage":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: THREAD, turnId: TURN, tokenUsage: { last: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 7 }, total: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 1, reasoningOutputTokens: 0, totalTokens: 13 } } } });
      itemCompleted("m1", reply);
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: reply }] });
      return;
    case "wrong-turn":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      delta("mX", "other turn noise", "turn-someone-else");
      delta("m1", "mine");
      itemCompleted("m1", "mine final");
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: "mine final" }] });
      return;
    case "wrong-thread":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      send({ method: "turn/completed", params: { threadId: "thread-other", turn: { id: TURN, status: "failed", error: { message: "wrong thread" } } } });
      itemCompleted("m1", reply);
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: reply }] });
      return;
    case "interruptible":
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      // 奇数轮等待中断；偶数轮正常完成，验证取消确认后可以继续下一轮。
      if (prompts % 2 === 0) { itemCompleted("m1", reply); turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: reply }] }); }
      return;
    default:
      send({ id: msg.id, result: { turn: { id: TURN, status: "inProgress" } } });
      itemCompleted("m1", reply);
      turnCompleted("completed", { items: [{ id: "m1", type: "agentMessage", text: reply }] });
  }
}

function handle(msg) {
  if (msg.method === "initialize") {
    switch (scenario) {
      case "hang-init": recordIn(JSON.stringify({ note: "hanging init" })); return;
      case "split-multibyte": {
        // 单条 JSON 记录在多字节字符中间拆成两次写入。
        const head = `{"id":${msg.id},"result":{"userAgent":"你`;
        const tail = `好🌍","codexHome":"/tmp"}}\n`;
        sendRaw(head); setTimeout(() => sendRaw(tail), 30);
        return;
      }
      case "multi-records": {
        // 一次写入包含多条记录与空行。
        const parts = [
          `{"id":${msg.id},"result":{"userAgent":"batch","codexHome":"/tmp"}}`,
          ``,
          `{"method":"remoteControl/status/changed","params":{"status":"disabled"}}`,
          `{"method":"thread/started","params":{"thread":{"id":"noise"}}}`,
        ];
        sendRaw(parts.join("\n") + "\n");
        return;
      }
      case "crlf": sendRaw(`{"id":${msg.id},"result":{"userAgent":"crlf","codexHome":"/tmp"}}\r\n`); return;
      case "u2028": {
        // 字符串值内的 U+2028/U+2029 不得被当作记录分隔符。
        const payload = JSON.stringify({ userAgent: "line sep here", codexHome: "/tmp" });
        sendRaw(`{"id":${msg.id},"result":${payload}}\n{"method":"after/u2028","params":{"ok":true}}\n`);
        return;
      }
      case "bad-json": sendRaw(`{"id":${msg.id},"resu`); sendRaw(`lt: not json at all\n`); return;
      case "exit-mid-line": sendRaw(`{"id":${msg.id},"resu`); process.exit(0); return;
      case "empty-lines": sendRaw("\n\n"); initResult(msg.id); sendRaw("\n"); return;
      default: initResult(msg.id); return;
    }
  }
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: THREAD }, model: msg.params?.model } }); return; }
  if (msg.method === "thread/resume") {
    if (scenario === "resume-missing") { send({ id: msg.id, error: { code: -32001, message: "Thread not found: does-not-exist" } }); return; }
    send({ id: msg.id, result: { thread: { id: msg.params?.threadId ?? THREAD } } });
    return;
  }
  if (msg.method === "turn/start") { turnFlow(msg); return; }
  if (msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
    turnCompleted("interrupted", {});
    return;
  }
  if (msg.method === "thread/read") { send({ id: msg.id, result: { items: [] } }); return; }
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
