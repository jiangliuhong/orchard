import { check } from "../domain/errors.js";
import { canonicalJson } from "../persistence/files.js";
import type { ProviderSessionReference, SessionLifecycleGuard } from "./provider-contract.js";
import { ConversationLocks } from "./locks.js";

/** 持久层端口；实现必须读取服务端真实记录，不能接收客户端传来的停止状态。 */
export interface LifecycleBinding {
  conversationId: string;
  revision: number;
  generation: number;
  reference: ProviderSessionReference;
  lifecycle: "active" | "deleting";
  hasActiveTurn: boolean;
}
export interface LifecycleGuardHost {
  load(conversationId: string): Promise<LifecycleBinding>;
  authorize(binding: LifecycleBinding, signal: AbortSignal): Promise<void>;
  /** 关闭所有目标写入连接并等待确实退出；崩溃遗留进程不能确认时返回 unknown。
   * 同时校验原生删除范围/派生会话归属和持久存储身份。不可仅检查 PID 是否存在。
   */
  stopAndConfirm(binding: LifecycleBinding, signal: AbortSignal): Promise<"stopped" | "unknown">;
}

/** 统一内核使用的 guard 实现。必须和发送/切模型/应用提案共享 ConversationLocks。
 * 构造参数来自已持久化的 delete operation；数据库端口审核完成前不接入旧运行时。
 */
export class BoundSessionLifecycleGuard implements SessionLifecycleGuard {
  constructor(private readonly locks: ConversationLocks, private readonly host: LifecycleGuardHost, private readonly expected: {
    conversationId: string;
    revision: number;
    generation: number;
  }) {}

  async withStoppedSession<T>(reference: ProviderSessionReference, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const referenceIdentity = canonicalJson(reference);
    return this.locks.run(this.expected.conversationId, signal, async () => {
      const validate = (binding: LifecycleBinding) => {
        check(binding.conversationId === this.expected.conversationId && binding.revision === this.expected.revision && binding.generation === this.expected.generation && canonicalJson(binding.reference) === referenceIdentity && canonicalJson(reference) === referenceIdentity,
          "BACKEND_BINDING_CONFLICT", "原生引用或操作代次已变化，禁止使用旧删除操作", 409);
        check(binding.lifecycle === "deleting", "INVALID_STATE", "删除操作尚未持久登记", 409);
        check(!binding.hasActiveTurn, "TURN_ACTIVE", "会话仍有活动或不确定轮次", 409);
      };
      const before = await this.host.load(this.expected.conversationId);
      validate(before);
      await this.host.authorize(before, signal);
      signal.throwIfAborted();
      check(await this.host.stopAndConfirm(before, signal) === "stopped", "PROCESS_STOP_UNCONFIRMED", "无法确认目标写入进程已停止", 409);
      // 外部异步步骤不能依赖锁前的 revision/权限快照。
      const after = await this.host.load(this.expected.conversationId);
      validate(after);
      await this.host.authorize(after, signal);
      signal.throwIfAborted();
      validate(after);
      return action();
    });
  }
}
