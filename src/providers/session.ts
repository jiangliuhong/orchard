import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { check } from "../domain/errors.js";
import { codexHome } from "./codex-config.js";
import type { BackendRef, ProviderCapabilities, ProviderSetting } from "../domain/types.js";
import type { ProviderEvent, ProviderResult, TurnRequest } from "./registry.js";

export type { ProviderEvent };
export type { TurnRequest, ProviderResult, BackendRef };

/**
 * Provider 会话契约（设计文档 §18.1）。用一个 `openSession` 表达创建／恢复，
 * 避免适配器靠全局“当前会话”找连接。`releaseSession` 释放连接或内存资源，
 * 不代表删除持久化历史。
 * BackendRef 定义于 domain/types.ts（后端引用为内部类型，不直接包含在公开 DTO）。
 */

export interface ProviderSessionHandle {
  key: string;
  generation: number;
  ref: BackendRef | null;
}

export type ExecutionContext = "isolated" | "project";

export interface SessionOpenRequest {
  /** 缺省沿用无工具策略；项目场景仅允许一次性会话。 */
  executionContext?: ExecutionContext;
  sessionDirectory?: string;
  /** 会话键（逻辑对话标识）；单次调用使用一次性匿名键。 */
  key: string;
  modelId: string;
  cwd: string;
  /** false 表示一次性上下文：Codex 用 ephemeral thread，Pi 用 --no-session。 */
  persistent: boolean;
  signal: AbortSignal;
  resumeRef?: BackendRef;
}

export interface SessionTurnRequest extends TurnRequest {
  hostTurnId: string;
  /** 后端接受 prompt 后必须 await 的回调；持久化失败时适配器应立即中断本轮。 */
  onAccepted: (backendTurnId: string | null) => Promise<void>;
}

export interface SessionProvider {
  getConnectionState?(handle: ProviderSessionHandle): import("../domain/types.js").ConnectionState;
  openSession(setting: ProviderSetting, request: SessionOpenRequest): Promise<ProviderSessionHandle>;
  sendTurn(handle: ProviderSessionHandle, request: SessionTurnRequest): Promise<ProviderResult>;
  interruptTurn(handle: ProviderSessionHandle, hostTurnId: string, signal: AbortSignal): Promise<void>;
  releaseSession(handle: ProviderSessionHandle): Promise<void>;
}

/** 原生适配器在 AgentProvider 上的挂载点：会话入口、能力计算与无模型探测。 */
export interface NativeAdapter {
  sessionProvider: SessionProvider;
  /** transport=native 时按配置计算实际能力。 */
  capabilities(setting: ProviderSetting): ProviderCapabilities;
  /** 无模型握手探测：完成后立即退出，不初始化持久草稿对话。 */
  probe(setting: ProviderSetting, signal: AbortSignal): Promise<void>;
}

/** 工具限制策略版本：禁用参数集合变化时递增，使连接指纹失效。 */
export const TOOL_POLICY_VERSION = "codex-appserver-v1";

/**
 * 连接指纹（设计文档 §17.1）：对白名单字段做 canonical JSON SHA-256。
 * 不散列或保存完整环境、config.toml 或认证文件。
 */
export function connectionFingerprint(setting: ProviderSetting, executionContext: ExecutionContext = "isolated"): string {
  const executable = String(setting.config.executable ?? "");
  check(typeof executable === "string" && isAbsolute(executable), "INVALID_EXECUTABLE", "CLI 路径必须为绝对路径");
  check(setting.config.transport === undefined || setting.config.transport === "native", "PROTOCOL_UNSUPPORTED", "仅支持原生协议");
  const transport = "native";
  const homeSource = setting.id === "codex-cli"
    ? `codex-home:${codexHome()}`
    : `pi-config:default`;
  const material = { providerId: setting.id, executable, transport, homeSource, toolPolicy: TOOL_POLICY_VERSION, executionContext };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
