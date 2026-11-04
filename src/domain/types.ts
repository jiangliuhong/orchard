export type JsonSchema = boolean | Record<string, unknown>;
export type Scalar = string | number | boolean | null;
export type Binding =
  | { source: "literal"; value: unknown }
  | { source: "workflow"; pointer?: string }
  | { source: "node"; nodeId: string; pointer?: string }
  | { source: "object"; properties: Record<string, Binding> }
  | { source: "array"; items: Binding[] };
export interface AgentChoice { providerId?: string; modelId?: string }
export interface WorkflowNode {
  id: string;
  name: string;
  type: "code.nodejs" | "agent" | "shell" | "switch";
  input: Binding;
  inputSchema?: JsonSchema;
  outputSchema: JsonSchema;
  config: {
    script?: string;
    resultMode?: "process" | "json";
    providerId?: string;
    modelId?: string;
    prompt?: string;
    cases?: { label: string; value: Scalar }[];
    defaultLabel?: string;
    timeoutMs?: number;
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
  defaults?: { agent?: AgentChoice };
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  result: Binding;
}
export type Layout = Record<string, { x: number; y: number }>;
export type SourceFiles = Record<string, string>;
export type RunStatus = "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped" | "interrupted";
export interface Failure { code: string; message: string }
export interface StreamEvent { streamType: string; streamId: string; sequence: number; type: string; nodeId?: string; attemptId?: string; payload: unknown; createdAt: number }
export interface ProviderCapabilities {
  modelCatalog: boolean;
  structuredOutput: "native" | "validated";
  tools: boolean;
  nativeResume: boolean;
  textStream: boolean;
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
  readiness: { state: "ready" | "unavailable" | "unknown"; reason?: string; version?: string };
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
  id: string; workflowVersionId: string; status: RunStatus; input: unknown; output?: unknown;
  activeNodeId: string | null; error?: Failure; createdAt: number; startedAt: number | null; endedAt: number | null;
}
export interface NodeRun {
  id: string; runId: string; nodeId: string; type: WorkflowNode["type"]; status: NodeStatus;
  input?: unknown; output?: unknown; route?: { edgeId: string; value: unknown; reason: string };
  skipReason?: string; error?: Failure; startedAt: number | null; endedAt: number | null;
}
export interface Turn {
  id: string; draftId: string; providerId: string; modelId: string; providerRevision: number;
  status: string; baseRevision: number; error?: Failure; createdAt: number; endedAt: number | null;
}
export interface Message { id: string; draftId: string; turnId: string | null; sequence: number; role: string; content: unknown; createdAt: number }
