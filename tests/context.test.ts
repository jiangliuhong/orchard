import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/domain/errors.js";
import {
  AUTHORING_PROMPT_RULES, HISTORY_EXCERPT_LIMITS, PROMPT_BYTE_LIMIT,
  buildAuthoringContext, composeAuthoringPrompt, historyExcerpt, truncateUtf8,
  type ContextHistoryMessage,
} from "../src/authoring/context.js";
import { applyAuthoringChanges, AUTHORING_SCHEMA } from "../src/authoring/service.js";
import type { ProviderView } from "../src/domain/types.js";
import { assertSchema } from "../src/domain/validation.js";

const message = (sequence: number, role: string, text: string | unknown): ContextHistoryMessage =>
  ({ sequence, role, content: typeof text === "string" ? { text } : text });

test("UTF-8 truncation lands on legal string boundaries without replacement characters", () => {
  assert.equal(truncateUtf8("hello", 100), "hello");
  assert.equal(truncateUtf8("hello", 3), "hel");
  // 多字节 emoji（4 字节）在序列中间截断时整字符丢弃。
  assert.equal(truncateUtf8("a🌍b", 2), "a");
  assert.equal(truncateUtf8("a🌍b", 5), "a🌍");
  // 中文（3 字节/字）边界。
  assert.equal(truncateUtf8("你好世界", 7), "你好");
  assert.equal(Buffer.from(truncateUtf8("你好世界", 7), "utf8").byteLength, 6);
  // 绝不产生 U+FFFD 替换字符或拆开的代理对。
  for (const size of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const cut = truncateUtf8("ué🚀漢", size);
    assert.ok(!cut.includes("\u{FFFD}"), `replacement char at size ${size}`);
    // 结尾不是孤立高代理。
    const last = cut.codePointAt(cut.length - 1);
    assert.ok(last !== undefined && last >= 0x20, `bad tail at size ${size}`);
  }
});

test("history excerpts keep newest messages within budget and restore original order", () => {
  // 全量装入：保持原顺序。
  const excerpt = historyExcerpt([message(1, "user", "第一"), message(2, "assistant", "第二"), message(3, "user", "第三")])!;
  assert.deepEqual(excerpt.messages.map(m => m.text), ["第一", "第二", "第三"]);
  assert.equal(excerpt.truncated, false);
  assert.equal(excerpt.source, "legacy");

  // 只摘取 user/assistant 的 text；error/诊断/无文本消息不复制。
  const filtered = historyExcerpt([
    message(1, "user", "keep me"),
    message(2, "error", { code: "X", message: "诊断不复制" }),
    message(3, "assistant", { text: "", files: ["a"] }),
    message(4, "assistant", "kept"),
  ])!;
  assert.deepEqual(filtered.messages.map(m => m.text), ["keep me", "kept"]);

  // 无可用文本 → undefined（envelope 不含 historyExcerpt）。
  assert.equal(historyExcerpt([message(1, "error", "x")]), undefined);
  assert.equal(historyExcerpt([]), undefined);

  // 从最近向前取，超出条数丢弃更早消息并记录 truncated。
  const many = Array.from({ length: 30 }, (_, index) => message(index + 1, "user", `m${index + 1}`));
  const capped = historyExcerpt(many)!;
  assert.equal(capped.messages.length, HISTORY_EXCERPT_LIMITS.maxMessages);
  assert.equal(capped.messages[0]!.text, "m11"); // 恢复原顺序后从第 11 条开始
  assert.equal(capped.messages.at(-1)!.text, "m30");
  assert.equal(capped.truncated, true);

  // 单条超过 8 KiB 时按边界截断该条。
  const long = historyExcerpt([message(1, "user", "长".repeat(9000))])!;
  assert.equal(long.messages.length, 1);
  assert.ok(Buffer.byteLength(long.messages[0]!.text) <= HISTORY_EXCERPT_LIMITS.perMessageBytes);
  assert.ok(long.messages[0]!.text.startsWith("长"));
  assert.equal(long.truncated, true);

  // 总预算 64 KiB：装满后停止并允许最后一条部分保留。
  const big = historyExcerpt(Array.from({ length: 12 }, (_, index) => message(index + 1, "user", "x".repeat(7 * 1024))))!;
  const total = big.messages.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
  assert.ok(total <= HISTORY_EXCERPT_LIMITS.totalBytes, `total ${total} exceeds budget`);
  assert.equal(big.truncated, true);
  assert.ok(big.messages.length >= 9);
});

test("envelope shapes distinguish initial, continuation and single contexts", () => {
  const providers: ProviderView[] = [{
    id: "test-provider", enabled: true, config: {}, models: [{ id: "m1", name: "M", source: "configured" }, { id: "m2", name: "Off", source: "configured", enabled: false }],
    defaultModel: "m1", revision: 1, updatedAt: 0, name: "Test", configSchema: true,
    capabilities: { modelCatalog: true, structuredOutput: "validated", tools: false, nativeResume: false, textStream: false, sessions: "none" },
    readiness: { state: "ready" },
  }];
  const files = { "workflow.json": "{}" };
  const history = [message(1, "user", "旧请求"), message(2, "assistant", "旧回复")];

  // initial（新后端上下文）：不带历史摘录。
  const initial = buildAuthoringContext({ kind: "initial", draftId: "d1", baseRevision: 3, files, providers, previousOutcome: null, history, userRequest: "新请求" });
  assert.equal(initial.contextVersion, 1);
  assert.equal(initial.kind, "initial");
  assert.equal(initial.historyExcerpt, undefined);
  const agents = initial.availableAgents as Array<{ id: string; enabled: boolean; models: Array<{ id: string }>; defaultModel: string; capabilities: unknown }>;
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!.id, "test-provider");
  assert.deepEqual(agents[0]!.models, [{ id: "m1", name: "M", source: "configured" }]); // 仅启用模型
  assert.equal(agents[0]!.defaultModel, "m1");

  // continuation（legacy 重建）：带确定性摘录与宿主上一轮结果。
  const continuation = buildAuthoringContext({ kind: "continuation", draftId: "d1", baseRevision: 4, files, providers, previousOutcome: { turnId: "t1", status: "succeeded", appliedRevision: 4, errorCode: null }, history, historySource: "legacy", userRequest: "继续" });
  assert.equal(continuation.kind, "continuation");
  assert.equal(continuation.historyExcerpt!.source, "legacy");
  assert.deepEqual(continuation.historyExcerpt!.messages.map(m => m.role), ["user", "assistant"]);
  assert.deepEqual(continuation.previousOutcome, { turnId: "t1", status: "succeeded", appliedRevision: 4, errorCode: null });

  // 用户显式重建：来源标记 explicit_rebuild。
  const rebuild = buildAuthoringContext({ kind: "initial", draftId: "d1", baseRevision: 4, files, providers, previousOutcome: { turnId: "t2", status: "failed", appliedRevision: null, errorCode: "INVALID_AGENT_OUTPUT" }, history, historySource: "explicit_rebuild", userRequest: "重建" });
  // initial 不带摘录（§18.2：single 每次 initial 且不含 historyExcerpt；重建摘录由受理层决定 kind）。
  assert.equal(rebuild.historyExcerpt, undefined);
});

test("composed prompts keep rules and reject the 512 KiB budget instead of trimming", () => {
  const providers: ProviderView[] = [];
  const context = buildAuthoringContext({ kind: "initial", draftId: "d", baseRevision: 0, files: { "workflow.json": "{}" }, providers, previousOutcome: null, userRequest: "hi" });
  const prompt = composeAuthoringPrompt(providers, context);
  for (const rule of AUTHORING_PROMPT_RULES) assert.ok(prompt.includes(rule));
  assert.ok(prompt.includes("Authoring context"));
  assert.ok(prompt.includes("hi"));

  // 完整 prompt 超过 512 KiB 直接拒绝，不截掉规则或 schema。
  const huge = buildAuthoringContext({ kind: "initial", draftId: "d", baseRevision: 0, files: { "workflow.json": "x".repeat(600 * 1024) }, providers, previousOutcome: null, userRequest: "hi" });
  assert.throws(() => composeAuthoringPrompt(providers, huge), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "CONTEXT_LIMIT");
    assert.ok(Buffer.byteLength(AUTHORING_PROMPT_RULES.join("\n")) < PROMPT_BYTE_LIMIT);
    return true;
  });
});

test("AUTHORING_SCHEMA stays the authoritative response contract", () => {
  assertSchema({ summary: "ok", changes: [] }, AUTHORING_SCHEMA);
  assert.throws(() => assertSchema({ summary: "ok" }, AUTHORING_SCHEMA));
  assert.throws(() => assertSchema({ summary: "ok", changes: [{ operation: "move", path: "a" }] }, AUTHORING_SCHEMA));
});

test("applyAuthoringChanges is a pure preparation stage with unchanged semantics", () => {
  const before = { "workflow.json": "{}", "scripts/a.ts": "export default 1;", "scripts/old.ts": "legacy" };
  // create/update/delete 正常应用，且不修改入参。
  const after = applyAuthoringChanges(before, [
    { operation: "create", path: "scripts/b.ts", content: "export default 2;" },
    { operation: "update", path: "scripts/a.ts", content: "export default 3;" },
    { operation: "delete", path: "scripts/old.ts" },
  ]);
  assert.deepEqual(after, { "workflow.json": "{}", "scripts/a.ts": "export default 3;", "scripts/b.ts": "export default 2;" });
  assert.deepEqual(Object.keys(before), ["workflow.json", "scripts/a.ts", "scripts/old.ts"]);

  // 拒绝重复路径。
  assert.throws(() => applyAuthoringChanges(before, [
    { operation: "update", path: "scripts/a.ts", content: "x" },
    { operation: "delete", path: "scripts/a.ts" },
  ]), /文件操作重复/);
  // 拒绝与原文件状态不一致的操作。
  assert.throws(() => applyAuthoringChanges(before, [{ operation: "create", path: "scripts/a.ts", content: "x" }]), /文件操作与草稿状态不一致/);
  assert.throws(() => applyAuthoringChanges(before, [{ operation: "update", path: "scripts/missing.ts", content: "x" }]), /文件操作与草稿状态不一致/);
  assert.throws(() => applyAuthoringChanges(before, [{ operation: "delete", path: "scripts/missing.ts" }]), /文件操作与草稿状态不一致/);
  // 拒绝缺少完整内容的 create/update。
  assert.throws(() => applyAuthoringChanges(before, [{ operation: "create", path: "scripts/c.ts" }]), /缺少完整文件内容/);
  // 拒绝越界路径。
  assert.throws(() => applyAuthoringChanges(before, [{ operation: "create", path: "../escape.ts", content: "" }]));
  // 无 changes 时返回等价副本。
  assert.deepEqual(applyAuthoringChanges(before, []), before);
});
