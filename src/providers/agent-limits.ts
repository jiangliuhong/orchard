/**
 * Agent 子进程与协议传输的运行时参数（设计文档 §23.1）。
 * 参数集中在此模块，可经构造参数覆盖以便测试；第一版不新增零散环境变量或 UI 配置。
 */
export interface AgentLimits {
  /** 全局并发子进程上限，包含探测、模型验证、单次及多轮进程。 */
  maxAgentProcesses: number;
  /** 等待进程槽位的排队上限，超过立即拒绝。 */
  maxQueuedTurns: number;
  /** 排队等待槽位的最长时间。 */
  queueWaitTimeoutMs: number;
  /** 协议握手（initialize / get_state）超时。 */
  initializeTimeoutMs: number;
  /** 单个请求等待响应确认的超时。 */
  requestAckTimeoutMs: number;
  /** 创作轮次总执行超时。 */
  authoringTurnTimeoutMs: number;
  /** 模型验证总超时（含排队与探测）。 */
  modelVerificationTotalTimeoutMs: number;
  /** 协议中断后等待后端停止的宽限时间。 */
  interruptGraceMs: number;
  /** SIGTERM 后升级为 SIGKILL 的宽限时间。 */
  terminateGraceMs: number;
  /** 空闲常驻进程回收时间。 */
  idleTtlMs: number;
  /** 单个连接未完成请求的数量上限。 */
  maxPendingRequestsPerConnection: number;
  /** stdin 写入缓冲的字节上限（背压队列）。 */
  maxBufferedWriteBytes: number;
  /** 单条协议记录的字节上限。 */
  maxProtocolRecordBytes: number;
  /** 每轮最终回复文本的字节上限。 */
  maxTurnTextBytes: number;
  /** 每轮诊断缓冲的字节上限。 */
  maxTurnDiagnosticBytes: number;
  /** 每轮协议累计字节上限（含未知通知与重复消息）。 */
  maxTurnProtocolBytes: number;
  /** 原生模式探测结果缓存时长。 */
  probeCacheMs: number;
  /** Pi 会话文件恢复时的单文件字节预算。 */
  maxSessionFileBytes: number;
}

export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = {
  maxAgentProcesses: 4,
  maxQueuedTurns: 32,
  queueWaitTimeoutMs: 60_000,
  initializeTimeoutMs: 10_000,
  requestAckTimeoutMs: 15_000,
  authoringTurnTimeoutMs: 600_000,
  modelVerificationTotalTimeoutMs: 60_000,
  interruptGraceMs: 5_000,
  terminateGraceMs: 300,
  idleTtlMs: 600_000,
  maxPendingRequestsPerConnection: 16,
  maxBufferedWriteBytes: 1024 * 1024,
  maxProtocolRecordBytes: 8 * 1024 * 1024,
  maxTurnTextBytes: 8 * 1024 * 1024,
  maxTurnDiagnosticBytes: 8 * 1024 * 1024,
  maxTurnProtocolBytes: 32 * 1024 * 1024,
  probeCacheMs: 60_000,
  maxSessionFileBytes: 64 * 1024 * 1024,
};

export function agentLimits(overrides: Partial<AgentLimits> = {}): AgentLimits {
  return { ...DEFAULT_AGENT_LIMITS, ...overrides };
}
