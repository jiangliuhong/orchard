import type { DictionaryBindings } from "./dictionaries.js";

export type JsonSchema = boolean | Record<string, unknown>;
export type Scalar = string | number | boolean | null;
export type Binding =
  | { source: "literal"; value: unknown }
  | { source: "workflow"; pointer?: string }
  | { source: "node"; nodeId: string; pointer?: string }
  | { source: "dictionary"; dictionaryId: string; key: string; pointer?: string }
  | { source: "object"; properties: Record<string, Binding> }
  | { source: "array"; items: Binding[] };
export interface AgentChoice { providerId?: string; modelId?: string }
export interface AgentConfigReference { agentConfigId?: string }
export interface AgentModelConfig {
  id: string; name: string; description: string; providerId: string; modelId: string;
  enabled: boolean; revision: number; createdAt: number; updatedAt: number;
}
export interface AgentModelConfigView extends AgentModelConfig {
  available: boolean; unavailableReason?: string; workflowCount: number; draftCount: number;
}
export interface RunAgentBinding {
  nodeId: string; configId: string; configRevision: number; name: string;
  providerId: string; modelId: string; providerRevision: number;
}
export interface WorkflowNode {
  id: string;
  name: string;
  type: "code.nodejs" | "agent" | "shell" | "script" | "switch" | "web-bridge";
  input: Binding;
  inputSchema?: JsonSchema;
  outputSchema: JsonSchema;
  config: {
    script?: string;
    dictionaryBindings?: DictionaryBindings;
    scriptId?: string;
    scriptVersionId?: string;
    resultMode?: "process" | "json";
    agentConfigId?: string;
    project?: { projectId: string };
    prompt?: string;
    cases?: { label: string; value: Scalar }[];
    defaultLabel?: string;
    timeoutMs?: number;
    application?: string;
    environmentId?: string;
    tool?: string;
  };
}
export interface WorkflowEdge { id: string; from: string; to: string | null; label?: string }
export interface Workflow {
  formatVersion: 1;
  id: string;
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  entryNodeId: string;
  defaults?: { agent?: AgentConfigReference };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  result: Binding;
}
export type Layout = Record<string, { x: number; y: number }>;
export type SourceFiles = Record<string, string>;
export type ScriptRuntime = "nodejs" | "shell";
export type ScriptStatus = "draft" | "published" | "archived";
export interface ScriptVersion {
  id: string; scriptId: string; number: number; status: "draft" | "published"; revision: number;
  name?: string; description?: string; resultMode?: "process" | "json";
  dictionaryBindings?: DictionaryBindings;
  metadataSnapshot?: boolean;
  entryFile: string; timeoutMs: number; inputSchema: JsonSchema; outputSchema: JsonSchema; sourceRef: string; contentHash: string;
  validation: { valid: boolean; diagnostics: string[] }; createdAt: number; updatedAt: number; publishedAt: number | null;
}
export interface ScriptView {
  id: string; name: string; description: string; runtime: ScriptRuntime; status: ScriptStatus;
  currentDraftVersionId: string | null; currentPublishedVersionId: string | null;
  createdAt: number; updatedAt: number; archivedAt: number | null;
}
export type RunStatus = "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "interrupted";
export interface Failure { code: string; message: string }
export interface StreamEvent { streamType: string; streamId: string; sequence: number; type: string; nodeId?: string; attemptId?: string; payload: unknown; createdAt: number }
export interface ProviderCapabilities {
  modelCatalog: boolean;
  structuredOutput: "native" | "validated";
  tools: boolean;
  /** 指定源码目录的一次性工具分析；不改变普通场景的 tools 策略。 */
  projectAnalysis?: boolean;
  nativeResume: boolean;
  textStream: boolean;
  /** 会话能力；旧 Provider 可缺省，由 registry 规范化为 "none"。 */
  sessions?: "none" | "memory" | "persistent";
}
export interface Model { id: string; name: string; source: "configured" | "discovered"; enabled?: boolean; deleted?: boolean }
export interface ModelVerification {
  providerId: string;
  modelId: string;
  providerRevision: number;
  status: "available" | "failed" | "cancelled";
  checkedAt: number;
  durationMs: number;
  responsePreview?: string;
  actualModelId?: string;
  error?: Failure;
}
export interface ProviderSetting {
  id: string; enabled: boolean; config: Record<string, unknown>; models: Model[];
  defaultModel: string; revision: number; updatedAt: number;
}
export interface ProviderView extends ProviderSetting {
  name: string; capabilities: ProviderCapabilities; configSchema: JsonSchema;
  readiness: { state: "ready" | "unavailable" | "unknown"; reason?: string; version?: string; transport?: "native"; errorCode?: string };
}
// ---- Agent 对话契约（设计文档 §18.1）；历史管理扩展见 history-feature.md ----
export type ConversationMode = "single" | "multi";
export type ContextMode = "isolated" | "native";
export type ConversationStatus = "current" | "idle" | "archived" | "needs_rebuild";
export type ConnectionState = "absent" | "starting" | "ready" | "stopping" | "broken";
export type AuthoringTurnStatus =
  | "queued" | "running" | "cancel_requested"
  | "succeeded" | "failed" | "cancelled" | "interrupted";
export type SubmissionState = "not_sent" | "sending" | "accepted" | "settled";
export interface ConversationView {
  id: string;
  draftId: string;
  mode: ConversationMode;
  contextMode: ContextMode;
  status: ConversationStatus;
  providerId: string;
  providerRevision: number;
  modelId: string;
  transport: "native";
  cliVersion: string | null;
  syncedRevision: number | null;
  rebuildFromId: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  connectionState: ConnectionState;
  /** 历史管理追加：落库标题（null 时由首条用户消息确定性推导展示）。 */
  title: string | null;
  archivedAt: number | null;
  /** 以下为查询推导字段，不落库。 */
  lastUserMessage: string | null;
  lastTurnStatus: string | null;
  activeTurnId: string | null;
}
export interface Version {
  id: string; workflowId: string; number: number; definition: Workflow; layout: Layout;
  artifactPath: string; contentHash: string; createdAt: number;
}
export interface Draft {
  id: string; workflowId: string | null; baseVersionId: string | null; revision: number;
  artifactPath: string; validation: { valid: boolean; diagnostics: string[] };
  publishedVersionId: string | null; status: string; createdAt: number; updatedAt: number;
}
export interface Run {
  id: string; workflowVersionId: string | null; draftId: string | null; draftRevision: number | null; snapshotPath: string | null;
  status: RunStatus; input: unknown; output?: unknown;
  inputRedacted?: boolean; outputRedacted?: boolean; logsRedacted?: boolean;
  dictionaryBindings?: { dictionaryId: string; versionId: string; kind: "plain" | "encrypted"; name: string; keys: string[] }[];
  activeNodeId: string | null; error?: Failure; createdAt: number; startedAt: number | null; endedAt: number | null;
}
export interface RunExecution { definition: Workflow; layout: Layout; artifactPath: string }
export interface RunSummary {
  id: string; workflowId: string | null; workflowName: string; workflowVersionId: string | null;
  versionNumber: number | null; draftId: string | null; draftRevision: number | null;
  status: RunStatus; createdAt: number; startedAt: number | null; endedAt: number | null;
}
export interface NodeRun {
  id: string; runId: string; nodeId: string; type: WorkflowNode["type"]; status: NodeStatus;
  inputRedacted?: boolean; outputRedacted?: boolean; logsRedacted?: boolean;
  input?: unknown; output?: unknown; route?: { edgeId: string; value: unknown; reason: string };
  skipReason?: string; error?: Failure; startedAt: number | null; endedAt: number | null;
}
export interface Turn {
  id: string; draftId: string; providerId: string; modelId: string; providerRevision: number;
  status: string; baseRevision: number; error?: Failure; createdAt: number; endedAt: number | null;
  conversationId?: string | null;
  backendTurnId?: string | null;
  connectionGeneration?: number | null;
  submissionState?: SubmissionState;
}
export interface Message { id: string; draftId: string; turnId: string | null; sequence: number; role: string; content: unknown; createdAt: number; conversationId?: string | null }
// 后端引用为内部类型，不直接包含在公开 DTO（§18.1）。
export type BackendRef =
  | { version: 1; kind: "codex"; threadId: string; cwd: string }
  | { version: 1; kind: "pi"; sessionId: string; sessionFile: string; cwd: string };
