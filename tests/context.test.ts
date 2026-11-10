import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/domain/errors.js";
import {
  AUTHORING_PROMPT_RULES, PROMPT_BYTE_LIMIT,
  buildAuthoringContext, composeAuthoringPrompt, historyExcerpt,
  type ContextHistoryMessage,
} from "../src/authoring/context.js";
import { applyAuthoringChanges, AUTHORING_SCHEMA } from "../src/authoring/service.js";
import type { ProviderView } from "../src/domain/types.js";
import { assertSchema } from "../src/domain/validation.js";

const message = (sequence: number, role: string, text: string | unknown): ContextHistoryMessage =>
  ({ sequence, role, content: typeof text === "string" ? { text } : text });

test("rebuild history keeps all saved messages, full proposals and errors in sequence order", () => {
  const proposal = { summary: "完整", changes: [{ operation: "update", path: "scripts/main.ts", content: "长".repeat(9000) }] };
  const messages = [
    ...Array.from({ length: 30 }, (_, index) => message(index + 1, "user", `m${index + 1}`)),
    message(31, "assistant", { text: "完整", proposal }),
    message(32, "error", { code: "FAILED", message: "failure detail" }),
  ];
  const history = historyExcerpt([...messages].reverse())!;
  assert.equal(history.source, "explicit_rebuild");
  assert.equal(history.truncated, false);
  assert.deepEqual(history.messages, messages.map(({ role, content }) => ({ role, content })));
  assert.equal(historyExcerpt([]), undefined);
  assert.equal(historyExcerpt([message(1, "provider.event", "not a saved dialogue message")]), undefined);
});

test("full rebuild history above the total prompt limit is rejected rather than truncated", () => {
  const history = [message(1, "user", "x".repeat(PROMPT_BYTE_LIMIT))];
  const context = buildAuthoringContext({
    kind: "initial", draftId: "d", baseRevision: 0, files: { "workflow.json": "{}" },
    providers: [], previousOutcome: null, history, historySource: "explicit_rebuild", userRequest: "continue",
  });
  assert.deepEqual(context.historyExcerpt!.messages[0]!.content, history[0]!.content);
  assert.equal(context.historyExcerpt!.truncated, false);
  assert.throws(() => composeAuthoringPrompt([], context), { code: "CONTEXT_LIMIT" });
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

  const continuation = buildAuthoringContext({ kind: "continuation", draftId: "d1", baseRevision: 4, files, providers, previousOutcome: { turnId: "t1", status: "succeeded", appliedRevision: 4, errorCode: null }, history, historySource: "explicit_rebuild", userRequest: "继续" });
  assert.equal(continuation.kind, "continuation");
  assert.equal(continuation.historyExcerpt!.source, "explicit_rebuild");
  assert.deepEqual(continuation.historyExcerpt!.messages.map(m => m.role), ["user", "assistant"]);
  assert.deepEqual(continuation.previousOutcome, { turnId: "t1", status: "succeeded", appliedRevision: 4, errorCode: null });

  // 用户显式重建：来源标记 explicit_rebuild。
  const rebuild = buildAuthoringContext({ kind: "initial", draftId: "d1", baseRevision: 4, files, providers, previousOutcome: { turnId: "t2", status: "failed", appliedRevision: null, errorCode: "INVALID_AGENT_OUTPUT" }, history, historySource: "explicit_rebuild", userRequest: "重建" });
  assert.equal(rebuild.historyExcerpt!.source, "explicit_rebuild");
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
