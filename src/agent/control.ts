import { AppError, check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { ConversationLocks } from "./locks.js";
import type { ProviderSessionLifecycle, ProviderSessionReference, SessionLifecycleGuard } from "./provider-contract.js";
import { AgentStore, type ConversationRow, type OperationRow } from "./store.js";

export interface AgentControlHost {
  authorize(actor: string, conversation: ConversationRow, signal: AbortSignal): Promise<void>;
  /** Must also confirm the data-directory writer lease and crash recovery. */
  stopAndConfirm(actor: string, conversation: ConversationRow, operation: OperationRow, signal: AbortSignal): Promise<"stopped" | "unknown">;
  revoke(conversationId: string): void;
  lifecycle(conversation: ConversationRow, guard: SessionLifecycleGuard): ProviderSessionLifecycle;
  releasePrivateResources(actor: string, conversation: ConversationRow, operation: OperationRow, signal: AbortSignal): Promise<void>;
}

/** Orchestrates the recoverable delete saga. Uses the same lock as submit/model
 * control, never interprets native references and never treats release as delete.
 */
export class AgentControl {
  constructor(private readonly store: AgentStore, private readonly locks: ConversationLocks, private readonly host: AgentControlHost) {}

  async delete(actor: string, id: string, input: { requestId: string; expectedRevision: number; confirmed: boolean }, signal: AbortSignal): Promise<OperationRow> {
    check(input.confirmed === true, "DELETE_CONFIRMATION_REQUIRED", "永久删除需要明确确认", 409);
    check(input.requestId.length > 0 && input.requestId.length <= 200 && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, "INVALID_REQUEST", "删除请求无效");
    return this.locks.run(id, signal, async () => {
      // beginControl resolves an authorized actor-bound tombstone before reading a deleted conversation.
      // For a new operation authorize BEFORE mutating its lifecycle.
      let prior: OperationRow | undefined;
      for (const row of this.store.db.prepare("SELECT id FROM agent_operations WHERE actor_key=? AND subject_id=? AND kind='delete' AND request_id=?").all(actor, id, input.requestId)) prior = this.store.operation(actor, String(row.id));
      if (!prior) await this.host.authorize(actor, this.store.conversation(actor, id), signal);
      signal.throwIfAborted();
      let { operation } = this.store.beginControl(actor, id, {
        kind: "delete", requestId: input.requestId, expectedRevision: input.expectedRevision,
        requestHash: digest(canonicalJson({ expectedRevision: input.expectedRevision, confirmed: true })),
      });
      if (operation.status === "succeeded") return operation;
      const conversation = this.store.conversation(actor, id);
      await this.host.authorize(actor, conversation, signal);
      const validate = () => {
        const current = this.store.conversation(actor, id), backend = this.store.backend(actor, id);
        check(current.lifecycle === "deleting" && current.revision === operation.expected_revision &&
          (backend?.generation ?? 0) === operation.expected_generation && (backend?.reference_json ?? null) === operation.target_reference_json,
        "BACKEND_BINDING_CONFLICT", "删除操作绑定已变化", 409);
        check(!this.store.db.prepare("SELECT id FROM agent_turns WHERE conversation_id=? AND (status IN ('queued','running','cancel_requested') OR submission_state IN ('sending','accepted')) LIMIT 1").get(id), "TURN_ACTIVE", "仍有活动或未核对轮次", 409);
        return current;
      };
      const stopped = async () => {
        const current = validate();
        await this.host.authorize(actor, current, signal);
        signal.throwIfAborted();
        check(await this.host.stopAndConfirm(actor, current, operation, signal) === "stopped", "PROCESS_STOP_UNCONFIRMED", "无法确认受管进程已停止", 409);
        await this.host.authorize(actor, validate(), signal);
        signal.throwIfAborted(); validate();
      };
      try {
        this.host.revoke(id);
        if (!["provider_confirmed", "platform_pending"].includes(operation.phase)) {
          if (operation.phase === "prepared") operation = this.store.controlProgress(actor, operation.id, { status: "running", phase: "closing" });
          await stopped();
          operation = this.store.controlProgress(actor, operation.id, { status: "running", phase: "provider_pending" });
          if (operation.target_reference_json !== null) {
            const expected = canonicalJson(JSON.parse(operation.target_reference_json));
            let guarded = false;
            // Already holding the conversation lock: never reacquire a non-reentrant lock.
            const guard: SessionLifecycleGuard = { withStoppedSession: async <T>(reference: ProviderSessionReference, guardSignal: AbortSignal, action: () => Promise<T>) => {
              check(guardSignal === signal && canonicalJson(reference) === expected, "BACKEND_BINDING_CONFLICT", "删除适配器请求了其他引用", 409);
              await stopped(); guarded = true;
              return action();
            } };
            const lifecycle = this.host.lifecycle(conversation, guard);
            const result = await lifecycle.deleteSession(JSON.parse(operation.target_reference_json) as ProviderSessionReference, signal);
            check(guarded && ["deleted", "already_absent"].includes(result.status), "NATIVE_DELETE_UNCONFIRMED", "缺少受保护的原生删除确认", 409);
          }
          validate(); signal.throwIfAborted();
          this.store.confirmNativeDeleted(actor, operation.id);
          operation = this.store.operation(actor, operation.id);
        }
        // Even after restart/native success, file cleanup requires fresh process proof.
        await stopped();
        await this.host.releasePrivateResources(actor, validate(), operation, signal);
        signal.throwIfAborted(); validate();
        operation = this.store.controlProgress(actor, operation.id, { status: "running", phase: "platform_pending" });
        return this.store.finalizeDelete(actor, operation.id);
      } catch (error) {
        operation = this.store.operation(actor, operation.id);
        return this.store.controlProgress(actor, operation.id, { status: "unknown", phase: operation.phase as Exclude<OperationRow["phase"], "done">,
          error: { code: error instanceof AppError ? error.code : "DELETE_FAILED" } });
      }
    });
  }
}
