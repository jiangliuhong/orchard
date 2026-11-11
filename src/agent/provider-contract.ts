import { Buffer } from "node:buffer";
import { check } from "../domain/errors.js";

/** P0 契约；尚未接入旧 Provider。未知/仅有协议声明的能力不能通过交付门禁。 */
export const REQUIRED_MULTI_CAPABILITIES = [
  "nativeSession", "nativeResume", "sharedReadOnlyWorkspace", "controlledKnowledge",
  "platformReadTools", "hostFeedback", "sameSessionModelSwitch", "nativeDelete",
  "deleteStateQuery",
] as const;
export type MultiCapability = typeof REQUIRED_MULTI_CAPABILITIES[number];

export type CapabilityEvidence =
  | { status: "verified"; evidence: string }
  | { status: "unverified" | "unsupported"; reason: string };

/** 证据绑定具体安装版本，而不是根据 Provider 名称推断。 */
export interface ProviderCapabilityReport {
  providerId: string;
  installedVersion: string;
  capabilities: Partial<Record<MultiCapability, CapabilityEvidence>>;
}

export function multiCapabilityBlockers(report: ProviderCapabilityReport, installedVersion: string): string[] {
  if (!installedVersion || report.installedVersion !== installedVersion) return ["version_mismatch"];
  return REQUIRED_MULTI_CAPABILITIES.filter(name => {
    const capability = report.capabilities[name];
    return capability?.status !== "verified" || !capability.evidence.trim();
  });
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 内部引用，不可出现在公开 DTO/诊断中；opaque 的含义只属于对应适配器。 */
export interface ProviderSessionReference {
  providerId: string;
  version: number;
  opaque: JsonValue;
}

export type NativeSessionState =
  | { status: "present" }
  | { status: "absent" }
  | { status: "unknown"; reason: string };

export interface DeleteResult {
  status: "deleted" | "already_absent";
}

/** 宿主校验引用的持久绑定、owner、generation 及原生删除范围，再提供操作锁/停机证明。
 * 整个 action 期间禁止新建或恢复目标写入连接；还须核对跨重启的受管存储身份。
 * 不能用客户端布尔值或单纯 PID 不存在替代。重启后的未知进程状态必须拒绝执行。
 */
export interface SessionLifecycleGuard {
  withStoppedSession<T>(reference: ProviderSessionReference, signal: AbortSignal, action: () => Promise<T>): Promise<T>;
}

/** 内部生命周期契约；不要求 CLI 暴露同名 RPC，不提供归档或恢复已删内容。 */
export interface ProviderSessionLifecycle {
  inspect(reference: ProviderSessionReference, signal: AbortSignal): Promise<NativeSessionState>;
  deleteSession(reference: ProviderSessionReference, signal: AbortSignal): Promise<DeleteResult>;
}

export interface ReferenceValidator {
  providerId: string;
  supportedVersions: readonly number[];
  /** 适配器必须检查 payload、路径归属和凭据禁存；宿主不解释 payload。 */
  validatePayload(opaque: JsonValue, version: number): void;
}

const MAX_REFERENCE_BYTES = 64 * 1024;

/** 拒绝 JSON.stringify 会静默丢弃/改写的值；禁止 toJSON、循环及过深对象。 */
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0, bytes: 0 }): asserts value is JsonValue {
  budget.nodes++;
  if (typeof value === "string") budget.bytes += Buffer.byteLength(value, "utf8");
  check(budget.nodes <= 8192 && budget.bytes <= MAX_REFERENCE_BYTES, "BACKEND_REFERENCE_INVALID", "后端引用超过大小预算");
  check(depth <= 32, "BACKEND_REFERENCE_INVALID", "后端引用嵌套过深");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    check(Number.isFinite(value), "BACKEND_REFERENCE_INVALID", "后端引用包含非法数值");
    return;
  }
  check(typeof value === "object", "BACKEND_REFERENCE_INVALID", "后端引用必须可无损 JSON 序列化");
  check(!ancestors.has(value), "BACKEND_REFERENCE_INVALID", "后端引用包含循环");
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "BACKEND_REFERENCE_INVALID", "后端引用包含非 JSON 对象");
  check(Object.getOwnPropertySymbols(value).length === 0, "BACKEND_REFERENCE_INVALID", "后端引用包含 Symbol");
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    check("value" in descriptor && descriptor.enumerable, "BACKEND_REFERENCE_INVALID", "后端引用包含访问器或隐藏字段");
    budget.bytes += Buffer.byteLength(key, "utf8");
    assertJson(descriptor.value, ancestors, depth + 1, budget);
  }
  if (Array.isArray(value)) {
    check(Object.keys(value).length === value.length && Object.keys(value).every(key => /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length),
      "BACKEND_REFERENCE_INVALID", "后端引用包含稀疏数组或额外数组字段");
  }
  ancestors.delete(value);
}

/** 所属 conversation 的关联/CAS 由存储层负责，本函数只校验引用边界。 */
export function validateSessionReference(value: unknown, adapter: ReferenceValidator): ProviderSessionReference {
  assertJson(value);
  check(value !== null && typeof value === "object" && !Array.isArray(value), "BACKEND_REFERENCE_INVALID", "后端引用必须是对象");
  check(Object.keys(value).length === 3 && Object.hasOwn(value, "providerId") && Object.hasOwn(value, "version") && Object.hasOwn(value, "opaque"),
    "BACKEND_REFERENCE_INVALID", "后端引用字段不合法");
  check(Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_REFERENCE_BYTES, "BACKEND_REFERENCE_INVALID", "后端引用超过大小预算");
  check(value.providerId === adapter.providerId, "BACKEND_PROVIDER_MISMATCH", "后端引用不属于当前 Provider");
  check(typeof value.version === "number" && Number.isSafeInteger(value.version) && value.version > 0 && adapter.supportedVersions.includes(value.version),
    "BACKEND_REFERENCE_VERSION_UNSUPPORTED", "后端引用版本不受支持");
  adapter.validatePayload(value.opaque!, value.version);
  return value as unknown as ProviderSessionReference;
}
