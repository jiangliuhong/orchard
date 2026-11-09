import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./helpers.js";
import { installFixture } from "./agent-fixtures.js";
import { agentLimits } from "../src/providers/agent-limits.js";
import { JsonlConnection } from "../src/providers/transport/jsonl.js";
import { PendingRequests } from "../src/providers/transport/pending.js";

type ProtocolRecord = { id?: number; method?: string; result?: { userAgent?: string }; params?: unknown };

async function collectRecords(executable: string, scenarioEnv: Record<string, string>, limits = agentLimits()) {
  const records: ProtocolRecord[] = [];
  const broken: { code: string; message: string }[] = [];
  const conn = JsonlConnection.start({
    executable, args: ["app-server"], cwd: "/tmp", limits: { ...limits, terminateGraceMs: 200 },
    onRecord: record => records.push(record as ProtocolRecord),
    onDiagnostic: () => {},
    onBroken: error => broken.push({ code: error.code, message: error.message }),
  });
  await conn.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "test", version: "0" } } }));
  void scenarioEnv;
  return { conn, records, broken };
}

test("JSONL framing handles multibyte splits, batched records, CRLF, U+2028/U+2029 and empty lines", async t => {
  // 单条 JSON 记录在多字节字符中间被拆成两次写入。
  {
    const { executable } = installFixture(t, "codex-server.mjs", "split-multibyte");
    const { conn, records } = await collectRecords(executable, {});
    await until(() => records.some(r => r.result));
    assert.equal(records.length, 1);
    assert.equal(records[0]!.result!.userAgent, "你好🌍");
    await conn.close();
  }
  // 一次写入包含多条记录与空行：全部完整送达，未知通知不参与协议判定。
  {
    const { executable } = installFixture(t, "codex-server.mjs", "multi-records");
    const { conn, records } = await collectRecords(executable, {});
    await until(() => records.length >= 3);
    assert.equal(records.find(r => r.id === 1)?.result?.userAgent, "batch");
    assert.ok(records.some(r => r.method === "remoteControl/status/changed"));
    assert.ok(records.some(r => r.method === "thread/started"));
    await conn.close();
  }
  // CRLF：行尾 CR 被剥离，记录可解析。
  {
    const { executable } = installFixture(t, "codex-server.mjs", "crlf");
    const { conn, records } = await collectRecords(executable, {});
    await until(() => records.some(r => r.result));
    assert.equal(records[0]!.result!.userAgent, "crlf");
    await conn.close();
  }
  // U+2028/U+2029 出现在字符串值内时不被当作分隔符。
  {
    const { executable } = installFixture(t, "codex-server.mjs", "u2028");
    const { conn, records } = await collectRecords(executable, {});
    await until(() => records.some(r => r.method === "after/u2028"));
    assert.equal(records[0]!.result!.userAgent, "line sep here");
    assert.equal(records.length, 2);
    await conn.close();
  }
  // 空行忽略。
  {
    const { executable } = installFixture(t, "codex-server.mjs", "empty-lines");
    const { conn, records } = await collectRecords(executable, {});
    await until(() => records.some(r => r.result));
    assert.equal(records.length, 1);
    await conn.close();
  }
});

test("truncated EOF and invalid JSON records break the connection with explicit errors", async t => {
  {
    const { executable } = installFixture(t, "codex-server.mjs", "exit-mid-line");
    const { conn, broken } = await collectRecords(executable, {});
    await until(() => broken.length > 0);
    assert.equal(broken[0]!.code, "PROCESS_EXITED_UNEXPECTEDLY");
    assert.match(broken[0]!.message, /记录中间结束|进程意外退出/);
    await conn.close();
  }
  {
    const { executable } = installFixture(t, "codex-server.mjs", "bad-json");
    const { conn, broken } = await collectRecords(executable, {});
    await until(() => broken.length > 0);
    assert.equal(broken[0]!.code, "PROTOCOL_STATE_INVALID");
    assert.match(broken[0]!.message, /合法 JSON/);
    await conn.close();
  }
});

test("stdin writes honour bounded backpressure and exceed-limit failures", async t => {
  const { executable } = installFixture(t, "codex-server.mjs", "ignore-stdin");
  const limits = agentLimits({ maxBufferedWriteBytes: 8192, terminateGraceMs: 200 });
  const conn = JsonlConnection.start({
    executable, args: ["app-server"], cwd: "/tmp", limits,
    onRecord: () => {}, onDiagnostic: () => {}, onBroken: () => {},
  });
  const errors: unknown[] = [];
  const payload = "x".repeat(512);
  try {
    // 不逐条 await，模拟快速连发：对端不读 stdin 时背压队列超过有界上限必须失败。
    for (let i = 0; i < 300; i++) {
      try { void conn.write(payload).catch(error => errors.push(error)); } catch (error) { errors.push(error); }
    }
    await until(() => errors.length > 0);
    assert.ok(errors.some(error => (error as { code?: string }).code === "OUTPUT_LIMIT"), `expected OUTPUT_LIMIT, got: ${errors.map(e => (e as { code?: string }).code)}`);
  } finally {
    await conn.close();
  }
});

test("pending requests reject individually on timeout and collectively on close", async () => {
  const pending = new PendingRequests(60, 8);
  const slow = pending.create("slow");
  const fast = pending.create("fast", 10);
  await assert.rejects(fast.promise, { code: "TIMEOUT" });
  const first = pending.create("first"), second = pending.create("second");
  assert.equal(pending.size, 3);
  pending.close();
  for (const entry of [slow, first, second]) await assert.rejects(entry.promise, { code: "PROCESS_EXITED_UNEXPECTEDLY" });
  assert.throws(() => pending.create("after-close"), /连接已关闭/);
});
