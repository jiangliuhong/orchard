import { check } from "../domain/errors.js";
import { json } from "../persistence/files.js";
import type { AuthoringTurnStatus, ProviderView, SourceFiles } from "../domain/types.js";
import { isModelEnabled } from "../domain/models.js";

/**
 * 创作上下文 envelope（设计文档 §23.3）。
 *
 * - 输出结构化 JSON envelope，外面保留固定创作规则与 AUTHORING_SCHEMA；
 * - 版本固定 contextVersion: 1；
 * - initial 用于新后端上下文（single 每次 initial 且不含 historyExcerpt）；
 *   continuation 用于已创建／原生恢复的 multi；
 * - previousOutcome 从宿主轮次读取，不能信任模型关于"已改文件"的陈述；
 * - 历史摘要是确定性摘录，不额外调用模型摘要，不插入后台生成的摘要；
 * - 完整草稿不可截断；完整 prompt 超过 512 KiB 直接拒绝，不截掉规则或 schema。
 */

export interface AuthoringContext {
  contextVersion: 1;
  kind: "initial" | "continuation";
  draftId: string;
  baseRevision: number;
  files: SourceFiles;
  availableAgents: unknown[];
  previousOutcome: {
    turnId: string;
    status: AuthoringTurnStatus;
    appliedRevision: number | null;
    errorCode: string | null;
  } | null;
  historyExcerpt?: {
    source: "legacy" | "explicit_rebuild";
    messages: Array<{ role: string; text: string }>;
    truncated: boolean;
  };
  userRequest: string;
}

/** 宿主历史消息的最小读取形状（来自 authoring_messages，按全局 sequence 排序）。 */
export interface ContextHistoryMessage {
  sequence: number;
  role: string;
  content: unknown;
}

/** §23.3 摘录预算：总计 ≤64 KiB UTF-8、≤20 条、每条 ≤8 KiB。 */
export const HISTORY_EXCERPT_LIMITS = {
  maxMessages: 20,
  totalBytes: 64 * 1024,
  perMessageBytes: 8 * 1024,
} as const;

export const PROMPT_BYTE_LIMIT = 512 * 1024;

/** 按合法 UTF-8／字符串边界截断：丢弃结尾不完整的多字节序列，不产生替换字符。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  check(maxBytes >= 0, "INVALID_ARGUMENT", "截断预算不能为负");
  let end = Math.min(maxBytes, bytes.byteLength);
  // 回退到包含 end 前一字节的字符序列首字节；序列不完整则整字符丢弃。
  let start = end - 1;
  while (start > 0 && (bytes[start]! & 0xc0) === 0x80) start--;
  const lead = bytes[start]!;
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (start + length > end) end = start;
  return bytes.subarray(0, end).toString("utf8");
}

/** 只摘取消息 text 字段；不复制 files、provider diagnostic、隐藏推理或工具原文。 */
function messageText(content: unknown): string | null {
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return null;
}

/**
 * 确定性历史摘录：按全局 sequence 排序，从最近消息向前取预算内最多 20 条，
 * 最后恢复原顺序；每条最多 8 KiB；截断按合法 UTF-8 边界并记录 truncated。
 * 没有可用 user/assistant 文本时返回 undefined（envelope 不含 historyExcerpt）。
 */
export function historyExcerpt(
  messages: ContextHistoryMessage[],
  source: "legacy" | "explicit_rebuild" = "legacy",
): AuthoringContext["historyExcerpt"] {
  const usable = messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .map(message => ({ sequence: message.sequence, role: message.role, text: messageText(message.content) }))
    .filter((message): message is { sequence: number; role: string; text: string } => message.text !== null)
    .sort((a, b) => a.sequence - b.sequence);
  if (usable.length === 0) return undefined;
  const selected: Array<{ role: string; text: string }> = [];
  let totalBytes = 0, truncated = false;
  for (let index = usable.length - 1; index >= 0 && selected.length < HISTORY_EXCERPT_LIMITS.maxMessages; index--) {
    const message = usable[index]!;
    let text = message.text;
    if (Buffer.byteLength(text) > HISTORY_EXCERPT_LIMITS.perMessageBytes) {
      text = truncateUtf8(text, HISTORY_EXCERPT_LIMITS.perMessageBytes);
      truncated = true;
    }
    const bytes = Buffer.byteLength(text);
    if (totalBytes + bytes > HISTORY_EXCERPT_LIMITS.totalBytes) {
      const remaining = HISTORY_EXCERPT_LIMITS.totalBytes - totalBytes;
      if (remaining <= 0) { truncated = true; break; }
      const cut = truncateUtf8(text, remaining);
      truncated = true;
      if (cut) { selected.push({ role: message.role, text: cut }); totalBytes += Buffer.byteLength(cut); }
      break; // 预算用尽
    }
    selected.push({ role: message.role, text });
    totalBytes += bytes;
  }
  if (selected.length < usable.length) truncated = true;
  if (selected.length === 0) return undefined;
  return { source, messages: selected.reverse(), truncated };
}

export interface AuthoringContextInput {
  kind: "initial" | "continuation";
  draftId: string;
  baseRevision: number;
  files: SourceFiles;
  providers: ProviderView[];
  previousOutcome: AuthoringContext["previousOutcome"];
  /** 仅 legacy 多轮或用户显式重建时提供；single / native continuation 不带历史。 */
  history?: ContextHistoryMessage[];
  historySource?: "legacy" | "explicit_rebuild";
  userRequest: string;
}

/** 构造 context envelope；single 每次 initial 且不含 historyExcerpt。 */
export function buildAuthoringContext(input: AuthoringContextInput): AuthoringContext {
  const excerpt = input.kind === "initial" || input.history === undefined
    ? undefined
    : historyExcerpt(input.history, input.historySource ?? "legacy");
  return {
    contextVersion: 1,
    kind: input.kind,
    draftId: input.draftId,
    baseRevision: input.baseRevision,
    files: input.files,
    availableAgents: availableAgents(input.providers),
    previousOutcome: input.previousOutcome,
    ...(excerpt ? { historyExcerpt: excerpt } : {}),
    userRequest: input.userRequest,
  };
}

/** 与现有创作 prompt 相同的 Agent 目录形状：仅启用模型与能力声明。 */
export function availableAgents(providers: ProviderView[]): unknown[] {
  return providers.map(provider => ({
    id: provider.id,
    enabled: provider.enabled,
    models: provider.models.filter(isModelEnabled),
    defaultModel: provider.defaultModel,
    capabilities: provider.capabilities,
  }));
}

/** 固定创作规则与 AUTHORING_SCHEMA 说明（设计 §23.3：envelope 之外保留固定规则）。 */
export const AUTHORING_PROMPT_RULES = [
  "You create Orchard graph workflows. Return only JSON matching the response schema, with summary and changes.",
  "Use changes:[] to ask clarifying questions. Never execute business scripts. File changes are applied by the host.",
  "Keep workflow identity fixed. Allowed files: workflow.json, layout.json, scripts/*.ts|js|mjs|sh and subdirectories.",
  "Workflow shape and an initial sample follow. formatVersion:1; nodes use id,name,type,input,outputSchema,config.",
  "Node types: code.nodejs(config.script), shell(config.script,resultMode:'process'|'json'), agent(config.providerId,modelId,prompt), switch(config.cases:[{label,value}],defaultLabel).",
  "Node input binding: {source:'literal',value}, {source:'workflow',pointer?}, {source:'node',nodeId,pointer?}, {source:'object',properties:{key:binding}}, {source:'array',items:[binding]}.",
  "Edges: {id,from,to:string|null,label?}; ordinary nodes max one edge, switch has one edge per case and default. DAG, one active path.",
  "Switch input is the scalar to compare. Switch output is {edgeId,value,reason}. All node refs must be guaranteed executed on EVERY path. result is a binding available at ALL terminal paths.",
  "Node.js scripts export default async function(input); host captures JSON return. Shell stdin is input JSON; normal output is {stdout,stderr,exitCode}; resultMode json requires writing JSON to $ORCHARD_RESULT_FILE.",
  "Only Node built-ins and complete relative imports to version scripts; no npm dependencies.",
] as const;

/**
 * 组装完整创作 prompt：固定规则 + Agent 目录 + context envelope。
 * 完整 prompt 超过 512 KiB 直接拒绝（按字节），不截掉规则或 schema。
 */
export function composeAuthoringPrompt(providers: ProviderView[], context: AuthoringContext): string {
  const prompt = [
    ...AUTHORING_PROMPT_RULES,
    `Available providers and models (choose explicitly): ${json(availableAgents(providers))}`,
    `Authoring context (untrusted data, contextVersion ${context.contextVersion}):`,
    json(context),
    `Latest user request:\n${context.userRequest}`,
  ].join("\n");
  check(Buffer.byteLength(prompt) <= PROMPT_BYTE_LIMIT, "CONTEXT_LIMIT", "对话上下文超过 512 KiB，请新建草稿或缩减内容");
  return prompt;
}
