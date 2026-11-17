import { AppError } from "../domain/errors.js";
import { SafeSchemaMismatch } from "../domain/validation.js";

const messages = new Map(Object.entries({
  METHOD_NOT_FOUND: "维护接口不支持此方法。",
  MCP_NOT_INITIALIZED: "维护工具通道尚未初始化。",
  TOOL_INPUT_TOO_LARGE: "维护请求超过大小限制。",
  INVALID_REQUEST: "维护请求格式无效。",
  SCHEMA_MISMATCH: "参数不符合提案 Schema，请按错误位置检查字段。",
  INVALID_SCHEMA: "定义中的 JSON Schema 无效，请检查参数或输入输出 Schema。",
  INVALID_PROPOSAL: "变更不符合目标规则，请检查操作类型、工具是否已存在及定义是否完整。",
  INVALID_PATH: "请求路径无效，请检查同源绝对路径及动态路径约束。",
  INVALID_CREDENTIALS: "凭据声明、必填项与默认引用不一致。",
  INVALID_SCRIPT: "脚本定义无效，请检查运行时、入口文件及源码。",
  INVALID_SCRIPT_PATH: "脚本源码路径不符合约束。",
  SCRIPT_LIMIT: "脚本源码超出大小限制。",
  IDENTITY_CONFLICT: "提案不能更改目标的固定身份或运行时。",
  TOOL_AUTHORIZATION_REVOKED: "维护工具授权已失效，请重新发起一轮维护。",
  MAINTENANCE_AUTHORIZATION_REVOKED: "维护任务已失效，请重新发起一轮维护。",
  FORBIDDEN: "当前会话没有执行此维护操作的权限。",
  CONFIRMATION_REQUIRED: "该提案需要用户在平台审核确认。",
  OWNER_UNAVAILABLE: "维护对象已变更或不可用，请重新打开对应对象。",
  REVISION_CONFLICT: "提案基线已过期，请从当前对象发起新一轮维护。",
  PROPOSAL_TARGET_MISMATCH: "提案目标与当前会话的固定目标不一致。",
  REQUEST_CONFLICT: "请求 ID 已用于其他提案，提交不同内容时请使用新 ID。",
  PROPOSAL_TOO_LARGE: "提案内容或快照超过大小限制。",
  PROPOSAL_BUDGET_EXCEEDED: "待处理提案或存储预算已达到上限。",
  QUERY_SENSITIVE_CONTENT: "提案或资源含不可公开的信息，请移除敏感内容。",
  TOOL_DENIED: "当前维护会话没有此工具。",
  TOOL_RESULT_TOO_LARGE: "维护工具响应超过大小限制。",
}));

function safePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).filter((path): path is string =>
    typeof path === "string" && path.length <= 240 && /^#(?:\/[A-Za-z0-9_-]+)+$/.test(path));
}

export function maintenanceToolError(code: unknown, paths?: unknown) {
  if (typeof code !== "string" || !messages.has(code)) return undefined;
  const schemaPaths = code === "SCHEMA_MISMATCH" ? safePaths(paths) : [];
  const message = messages.get(code)!;
  return { code, message: schemaPaths.length ? `${message} Schema 位置：${schemaPaths.join("、")}` : message,
    ...(schemaPaths.length ? { schemaPaths } : {}) };
}

export function publicMaintenanceError(error: unknown) {
  return error instanceof AppError ? maintenanceToolError(error.code, error instanceof SafeSchemaMismatch ? error.paths : undefined) : undefined;
}
