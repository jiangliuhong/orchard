import { check } from "../domain/errors.js";
import { ConversationLocks } from "./locks.js";
import { AgentStore, type ConversationRow } from "./store.js";

export interface HostFeedback {
  eventId: string; conversationId: string; turnId: string | null; operationId: string | null;
  generation: number; type: "applied" | "rejected" | "resource_changed" | "selected_test_changed";
  payload: Record<string, unknown>;
}
export interface FeedbackReceipt { eventId: string; confirmed: true; [key: string]: unknown }
export type FeedbackInspection = { status: "delivered"; receipt: FeedbackReceipt } | { status: "absent" | "unknown" };
export interface FeedbackHost {
  authorize(actor: string, conversation: ConversationRow, signal: AbortSignal): Promise<void>;
  /** Both operations MUST NOT start model generation. absent must be authoritative. */
  inspect(conversation: ConversationRow, feedback: HostFeedback, signal: AbortSignal): Promise<FeedbackInspection>;
  deliver(conversation: ConversationRow, feedback: HostFeedback, signal: AbortSignal): Promise<FeedbackReceipt>;
}

/** Crash-safe outbox dispatcher. A lost response becomes unknown, not pending;
 * inspect before resending, and block later facts behind an uncertain predecessor.
 */
export class HostFeedbackDispatcher {
  constructor(private readonly store: AgentStore, private readonly locks: ConversationLocks, private readonly host: FeedbackHost) {}

  async flush(actor: string, id: string, signal: AbortSignal): Promise<{ delivered: number; blocked: boolean }> {
    return this.locks.run(id, signal, async () => {
      let delivered = 0;
      const current = () => {
        const conversation = this.store.conversation(actor, id);
        check(conversation.lifecycle === "active" && conversation.usability === "usable", "CONVERSATION_READ_ONLY", "不可用对话不能接收反馈", 409);
        check(!this.store.db.prepare("SELECT id FROM agent_turns WHERE conversation_id=? AND (status IN ('queued','running','cancel_requested') OR submission_state IN ('sending','accepted')) LIMIT 1").get(id), "TURN_ACTIVE", "活动或未核对轮次不能投递闲置反馈", 409);
        check(!this.store.db.prepare("SELECT id FROM agent_operations WHERE conversation_id=? AND kind IN ('delete','switch_model') AND settled_at IS NULL LIMIT 1").get(id), "OPERATION_ACTIVE", "控制操作期间不能投递反馈", 409);
        return conversation;
      };
      await this.host.authorize(actor, current(), signal);
      for (const row of this.store.pendingFeedback(actor, id)) {
        signal.throwIfAborted();
        const conversation = current();
        await this.host.authorize(actor, conversation, signal);
        signal.throwIfAborted(); current();
        const feedback: HostFeedback = {
          eventId: row.event_id as string, conversationId: id, turnId: row.turn_id as string | null,
          operationId: row.operation_id as string | null, generation: row.generation as number,
          type: row.type as HostFeedback["type"], payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
        };
        // Persist uncertainty BEFORE crossing the external side-effect boundary.
        const uncertain = row.status === "unknown";
        this.store.feedbackReceipt(actor, id, feedback.eventId, { status: "unknown" });
        try {
          let receipt: FeedbackReceipt;
          if (uncertain) {
            const inspection = await this.host.inspect(conversation, feedback, signal);
            if (inspection.status === "unknown") return { delivered, blocked: true };
            if (inspection.status === "delivered") receipt = inspection.receipt;
            else {
              await this.host.authorize(actor, current(), signal);
              signal.throwIfAborted(); current();
              receipt = await this.host.deliver(conversation, feedback, signal);
            }
          } else receipt = await this.host.deliver(conversation, feedback, signal);
          current();
          this.store.feedbackReceipt(actor, id, feedback.eventId, { status: "delivered", receipt });
          delivered++;
        } catch { return { delivered, blocked: true }; }
      }
      return { delivered, blocked: false };
    });
  }
}
