import { AppError, check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import { ConversationLocks } from "./locks.js";
import { AgentStore, type ConversationRow, type OperationRow } from "./store.js";

export type ModelSwitchResult =
  | { status: "confirmed"; modelId: string }
  | { status: "unchanged"; modelId: string; code: string }
  | { status: "unknown" };
export interface ModelControlHost {
  authorize(actor: string, conversation: ConversationRow, signal: AbortSignal): Promise<void>;
  validateModel(conversation: ConversationRow, modelId: string, signal: AbortSignal): Promise<void>;
  /** Must preserve the exact native reference, not rebuild/replay/create a new session.
   * unchanged requires proof that any partial change was rolled back. */
  switchModel(conversation: ConversationRow, operation: OperationRow, modelId: string, signal: AbortSignal): Promise<ModelSwitchResult>;
  /** Inspect a possibly committed switch without sending it again or generating. */
  inspect(conversation: ConversationRow, operation: OperationRow, modelId: string, signal: AbortSignal): Promise<ModelSwitchResult>;
}

export class AgentModelControl {
  constructor(private readonly store: AgentStore, private readonly locks: ConversationLocks, private readonly host: ModelControlHost) {}

  async switch(actor: string, id: string, input: { requestId: string; expectedRevision: number; modelId: string }, signal: AbortSignal): Promise<OperationRow> {
    check(input.requestId.length > 0 && input.requestId.length <= 200 && input.modelId.length > 0 && input.modelId.length <= 200 &&
      !/^\s*-|[\0\r\n]/.test(input.modelId) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0, "INVALID_REQUEST", "模型切换请求无效");
    return this.locks.run(id, signal, async () => {
      const conversation = this.store.conversation(actor, id);
      check(conversation.mode === "multi", "INVALID_STATE", "single 对话不能切换模型", 409);
      await this.host.authorize(actor, conversation, signal);
      // Check idempotency before provider availability: a completed request remains queryable.
      const hash = digest(canonicalJson({ expectedRevision: input.expectedRevision, modelId: input.modelId }));
      const prior = this.store.db.prepare("SELECT id,request_hash FROM agent_operations WHERE actor_key=? AND subject_id=? AND kind='switch_model' AND request_id=?").get(actor, id, input.requestId);
      let reconcile = false;
      if (prior) {
        check(prior.request_hash === hash, "REQUEST_CONFLICT", "请求标识已用于不同模型切换", 409);
        const operation = this.store.operation(actor, String(prior.id));
        if (operation.settled_at !== null) return operation;
        reconcile = operation.phase === "provider_pending";
      }
      // Inspect already-issued work even if the target model has since been disabled.
      // Only a fresh switch needs permission to select the model; owner authorization
      // still applies to both paths, and inspect must not resend or generate.
      if (!reconcile) await this.host.validateModel(conversation, input.modelId, signal);
      signal.throwIfAborted();
      const { operation } = this.store.beginControl(actor, id, { kind: "switch_model", requestId: input.requestId, requestHash: hash, expectedRevision: input.expectedRevision, requestedModelId: input.modelId });
      const current = this.store.conversation(actor, id);
      try {
        await this.host.authorize(actor, current, signal);
        signal.throwIfAborted();
        const uncertain = operation.phase === "provider_pending";
        this.store.controlProgress(actor, operation.id, { status: "running", phase: "provider_pending" });
        const result = uncertain ? await this.host.inspect(current, operation, input.modelId, signal) : await this.host.switchModel(current, operation, input.modelId, signal);
        if (result.status === "confirmed") {
          check(result.modelId === input.modelId, "MODEL_SWITCH_UNCONFIRMED", "实际模型与请求不一致", 409);
          this.store.finishModelSwitch(actor, operation.id, { confirmedModelId: result.modelId });
        } else if (result.status === "unchanged") {
          check(result.modelId === current.current_model_id, "MODEL_SWITCH_UNCONFIRMED", "无法确认失败后保持旧模型", 409);
          this.store.finishModelSwitch(actor, operation.id, { error: { code: result.code } });
        } else this.store.controlProgress(actor, operation.id, { status: "unknown", phase: "provider_pending", error: { code: "MODEL_SWITCH_UNCONFIRMED" } });
      } catch (error) {
        this.store.controlProgress(actor, operation.id, { status: "unknown", phase: "provider_pending", error: { code: error instanceof AppError ? error.code : "MODEL_SWITCH_UNCONFIRMED" } });
      }
      return this.store.operation(actor, operation.id);
    });
  }
}
