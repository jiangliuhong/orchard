import { AppError, check } from "../domain/errors.js";
import { ConversationLocks } from "./locks.js";
import { AgentStore, type ConversationRow, type TurnRow } from "./store.js";

type BackendBinding = Parameters<AgentStore["saveBackend"]>[2];
type TurnOutcome = Pick<Parameters<AgentStore["settle"]>[2], "actualModelId" | "modelSource" | "proposalRef"> & {
  baseRevision?: string;
};

export interface RuntimeSession {
  generation: number;
  /** Required on first multi open or when resume changes the persisted binding. */
  binding?: Pick<BackendBinding, "reference" | "fingerprint" | "validator">;
  /** Resolve only on a confirmed terminal provider response for this turn. */
  send(request: { signal: AbortSignal; accepted(): void }): Promise<TurnOutcome>;
  /** Resolve true only after confirming this generation can no longer write this turn. */
  stop(): Promise<boolean>;
}

export interface RuntimeTurnHost {
  authorize(actor: string, conversation: ConversationRow, signal: AbortSignal): Promise<void>;
  /** Own workspace/tool/private-resource leases for the whole action, including stop.
   * Validate provider capabilities and exact native resume before invoking action.
   * A failure before action must never have submitted a native turn.
   */
  withSession<T>(input: {
    actor: string; conversation: ConversationRow; turn: TurnRow; signal: AbortSignal;
    backend: ReturnType<AgentStore["backend"]>;
  }, action: (session: RuntimeSession) => Promise<T>): Promise<T>;
}

interface RunningTurn {
  controller: AbortController;
  completion: Promise<TurnRow>;
}

/** Executes a logical turn once. Provider handles, native paths and workspace leases stay in the host. */
export class AgentRuntime {
  private readonly running = new Map<string, RunningTurn>();

  constructor(
    private readonly store: AgentStore,
    private readonly locks: ConversationLocks,
    private readonly host: RuntimeTurnHost,
  ) {}

  async submit(actor: string, conversationId: string, input: Parameters<AgentStore["submit"]>[2], signal: AbortSignal) {
    signal.throwIfAborted();
    await this.host.authorize(actor, this.store.conversation(actor, conversationId), signal);
    signal.throwIfAborted();
    const submission = this.store.submit(actor, conversationId, input);
    if (!submission.created) return submission;
    const controller = new AbortController();
    const completion = this.execute(actor, submission.turn, AbortSignal.any([controller.signal, signal]));
    this.running.set(submission.turn.id, { controller, completion });
    void completion.then(
      () => this.running.delete(submission.turn.id),
      () => this.running.delete(submission.turn.id),
    );
    return submission;
  }

  async cancel(actor: string, turnId: string): Promise<TurnRow> {
    const turn = this.store.turn(actor, turnId);
    if (!["queued", "running", "cancel_requested"].includes(turn.status)) return turn;
    const running = this.running.get(turnId);
    check(running, "PROCESS_STOP_UNCONFIRMED", "无法确认轮次所属的运行进程", 409);
    this.store.requestCancel(actor, turnId);
    running.controller.abort(new AppError("CANCELLED", "轮次已请求取消"));
    return running.completion;
  }

  async wait(actor: string, turnId: string): Promise<TurnRow> {
    const turn = this.store.turn(actor, turnId);
    return this.running.get(turnId)?.completion ?? turn;
  }

  private async execute(actor: string, queued: TurnRow, signal: AbortSignal): Promise<TurnRow> {
    try {
      return await this.locks.run(queued.conversation_id, signal, async () => {
        const conversation = this.store.conversation(actor, queued.conversation_id);
        await this.host.authorize(actor, conversation, signal);
        signal.throwIfAborted();
        const backend = this.store.backend(actor, conversation.id);
        return this.host.withSession({ actor, conversation, turn: queued, backend, signal }, async session => {
          try {
            signal.throwIfAborted();
            if (session.binding) {
              this.store.saveBackend(actor, conversation.id, {
                ...session.binding, generation: session.generation,
                expectedRevision: conversation.revision, expectedGeneration: backend?.generation ?? 0,
              });
            }
            this.store.markSending(actor, queued.id, session.generation);
            const outcome = await session.send({
              signal,
              accepted: () => this.store.markAccepted(actor, queued.id, session.generation),
            });
            signal.throwIfAborted();
            return this.store.transaction(() => {
              if (outcome.proposalRef !== undefined) {
                check(outcome.baseRevision, "BASELINE_NOT_QUERIED", "提案缺少当前对象 revision", 409);
                this.store.recordProposalBaseline(actor, queued.id, outcome.baseRevision);
              }
              return this.store.settle(actor, queued.id, {
                generation: session.generation, status: "succeeded",
                actualModelId: outcome.actualModelId, modelSource: outcome.modelSource,
                proposalRef: outcome.proposalRef, applyStatus: outcome.proposalRef === undefined ? "not_applicable" : "pending",
              });
            });
          } catch (error) {
            let stopped = false;
            try { stopped = await session.stop(); } catch { /* The provider could still be writing. */ }
            const turn = this.store.turn(actor, queued.id);
            if (!stopped && turn.submission_state !== "not_sent") {
              return this.store.interruptUnconfirmed(actor, turn.id, turn.generation);
            }
            return this.fail(actor, turn, signal, error);
          }
        });
      });
    } catch (error) {
      const turn = this.store.turn(actor, queued.id);
      if (!["queued", "running", "cancel_requested"].includes(turn.status)) return turn;
      if (turn.submission_state !== "not_sent") return this.store.interruptUnconfirmed(actor, turn.id, turn.generation);
      return this.fail(actor, turn, signal, error);
    }
  }

  private fail(actor: string, turn: TurnRow, signal: AbortSignal, error: unknown): TurnRow {
    return this.store.settle(actor, turn.id, {
      generation: turn.generation,
      status: signal.aborted ? "cancelled" : "failed",
      error: { code: signal.aborted ? "CANCELLED" : error instanceof AppError ? error.code : "EXECUTION_FAILED" },
    });
  }
}
