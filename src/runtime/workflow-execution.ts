import type { NodeRegistry, StepRequest, WorkflowDefinition } from "../workflow-sdk/index.js";
import { createWorkflowContext, validateWorkflowInput } from "../workflow-sdk/index.js";
import { ContinuationRepository, EventRepository, RunRepository, StepRepository, WorkflowRepository } from "../storage/database.js";
import { WorkflowSuspended } from "./suspension.js";
import type { OrchardDatabase } from "../storage/database.js";
import { StepRunner } from "./step-runner.js";

/** A timeout is a failed attempt, not a user cancellation. */
export class WorkflowTimeoutError extends Error {
  readonly retryable = true;
  constructor(readonly timeoutMs: number) {
    super(`Workflow timed out after ${timeoutMs}ms`);
    this.name = "WORKFLOW_TIMEOUT";
  }
}

export class WorkflowExecutionService {
  private readonly steps: StepRepository;
  private readonly runner: StepRunner;
  private readonly continuations: ContinuationRepository;

  constructor(private readonly db: OrchardDatabase, nodes: NodeRegistry) {
    this.steps = new StepRepository(db);
    this.continuations = new ContinuationRepository(db);
    this.runner = new StepRunner(nodes);
  }

  async execute<Input, Output>(runId: string, workflow: WorkflowDefinition<Input, Output>, input: unknown, signal: AbortSignal): Promise<Output> {
    validateWorkflowInput(workflow, input);
    const timeoutMs = workflow.policy?.timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timeoutController: AbortController | undefined;
    if (timeoutMs !== undefined) {
      timeoutController = new AbortController();
      timeout = setTimeout(() => timeoutController!.abort(new WorkflowTimeoutError(timeoutMs)), timeoutMs);
      signal = AbortSignal.any([signal, timeoutController.signal]);
    }
    signal.throwIfAborted();
    let operation = 0;
    const pause = async <T>(kind: 'sleep' | 'wait', deadline?: number, eventName?: string, matchKey?: string, operationId?: string): Promise<T> => {
      signal.throwIfAborted();
      const stableId = operationId ?? matchKey;
      if (!stableId) throw new Error(`Durable ${kind} requires an explicit operation id`);
      const stepKey = `operation:${stableId}:${kind}`;
      const idempotencyKey = `${runId}:${stepKey}`;
      const saved = this.continuations.getByKey(idempotencyKey);
      if (saved?.status === 'resumed') {
        const payload = saved.payload as { timeout?: boolean; event?: T } | undefined;
        return (payload?.timeout ? null : payload?.event) as T;
      }
      if (saved?.status === 'cancelled') throw new Error('Continuation cancelled');
      this.continuations.create({ runId, stepKey, kind, idempotencyKey, ...(deadline === undefined ? {} : { resumeAt: deadline }), ...(eventName === undefined ? {} : { eventName }), ...(matchKey === undefined ? {} : { matchKey }) });
      if (!this.continuations.pause(runId, kind === 'sleep' ? 'sleeping' : 'waiting')) throw new Error('Run cannot be suspended');
      throw new WorkflowSuspended();
    };
    const sleepUntil = async (atOrId: Date | number | string, maybeAt?: Date | number): Promise<void> => {
      const operationId = typeof atOrId === 'string' ? atOrId : undefined;
      const at = typeof atOrId === 'string' ? maybeAt : atOrId;
      if (!operationId) throw new Error('Durable sleepUntil requires an explicit operation id');
      const deadline = typeof at === 'number' ? at : at instanceof Date ? at.getTime() : NaN;
      if (!Number.isFinite(deadline)) throw new Error('Invalid sleep deadline');
      return pause<void>('sleep', deadline, undefined, operationId);
    };
    const runs = new RunRepository(this.db);
    const pending = new Set<Promise<unknown>>();
    const dispatch = <T>(stepId: string, request: StepRequest): Promise<T> => {
      const task = this.executeStep<T>(runId, stepId, request, signal, workflow.policy?.retry);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    };
    const context = createWorkflowContext(runId, signal, dispatch, {
      sleep: async (idOrMs, maybeMs) => { const operationId = typeof idOrMs === 'string' ? idOrMs : undefined; const ms = typeof idOrMs === 'string' ? maybeMs : idOrMs; if (!operationId) throw new Error('Durable sleep requires an explicit operation id'); if (ms === undefined || !Number.isFinite(ms) || ms < 0) throw new Error('Invalid sleep duration'); return pause<void>('sleep', Date.now() + ms, undefined, undefined, operationId); },
      sleepUntil,
      sendEvent: async (eventName, data, options) => {
        signal.throwIfAborted();
        const stepKey = `operation:${options?.id ?? ''}:send`;
        if (!options?.id) throw new Error('Durable sendEvent requires an explicit operation id');
        const eventId = options?.id ?? `${runId}:${stepKey}`;
        const delivered = new EventRepository(this.db).deliverMatching({ source: `workflow:${runId}`, eventId, name: eventName, data,
          createRun: (trigger, incomingId) => runs.createRunForWorkflow({ workflowId: trigger.workflowId, ...(trigger.workflowVersionId ? { workflowVersionId: trigger.workflowVersionId } : {}), inputRef: JSON.stringify(data), triggerId: trigger.id, idempotencyKey: `${incomingId}:${trigger.id}` }).id,
        });
        return delivered.event.id;
      },
      invokeWorkflow: async <T>(workflowId: string, childInput: unknown, options?: { id?: string; idempotencyKey?: string }): Promise<T> => {
        signal.throwIfAborted();
        const stepKey = `operation:${options?.id ?? ''}:invoke`;
        if (!options?.id) throw new Error('Durable invokeWorkflow requires an explicit operation id');
        const idempotencyKey = `${runId}:${options?.idempotencyKey ?? stepKey}`;
        const prior = this.db.database.prepare('SELECT child_run_id AS childRunId FROM run_links WHERE parent_run_id = ? AND parent_step_key = ?').get(runId, stepKey) as { childRunId: string } | undefined;
        let childId = prior?.childRunId;
        if (!childId) {
          const versionId = new WorkflowRepository(this.db).getCurrentVersionId(workflowId);
          if (!versionId) throw new Error('WORKFLOW_NOT_FOUND');
          childId = runs.createChildRun({ parentRunId: runId, parentStepKey: stepKey, workflowVersionId: versionId, inputRef: JSON.stringify(childInput ?? null), idempotencyKey }).id;
        }
        const child = this.db.database.prepare('SELECT status, output_ref AS output FROM runs WHERE id = ?').get(childId) as { status: string; output: string | null };
        if (child.status === 'succeeded') return (child.output == null ? null : JSON.parse(child.output)) as T;
        if (['failed', 'cancelled', 'interrupted', 'needs_review'].includes(child.status)) throw new Error(`Child run ${child.status}`);
        this.continuations.create({ runId, stepKey, kind: 'invoke', idempotencyKey, payload: { childRunId: childId } });
        if (!this.continuations.pause(runId, 'waiting')) throw new Error('Run cannot be suspended');
        throw new WorkflowSuspended();
      },
      waitForEvent: <T>(eventName: string, options?: { id?: string; timeoutMs?: number; key?: string }) => {
        if (!eventName || (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0))) throw new Error('Invalid event wait');
        return pause<T>('wait', options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs, eventName, options?.key, options?.id);
      },
    });
    try {
      const output = await new Promise<Output>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void Promise.resolve().then(() => workflow.run(context, input)).then(
          value => { signal.removeEventListener('abort', abort); resolve(value); },
          error => { signal.removeEventListener('abort', abort); reject(error); },
        );
      });
      await Promise.all(pending);
      signal.throwIfAborted();
      return output;
    } catch (error) {
      // Preserve the structured timeout cause. AbortSignal.throwIfAborted()
      // otherwise turns it into an indistinguishable cancellation.
      if (timeoutController?.signal.aborted) throw timeoutController.signal.reason;
      // Aborted work cannot commit late success (StepRunner checks the signal).
      signal.throwIfAborted();
      // Parallel work already started must settle before releasing ownership.
      await Promise.allSettled(pending);
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async executeStep<T>(runId: string, stepId: string, request: StepRequest, signal: AbortSignal, retry?: import('../core/contracts.js').WorkflowRetryPolicy): Promise<T> {
      signal.throwIfAborted();
      if (!request || typeof request !== "object" || typeof request.type !== "string") throw new Error("Step requires an Orchard StepRequest");
      const previous = this.steps.getSuccessful(runId, stepId);
      if (previous) return previous.output as T;
      const delayed = this.continuations.list(runId).find(item => item.kind === 'retry' && item.status === 'waiting' && (item.payload as { stepId?: string } | undefined)?.stepId === stepId);
      if (delayed) {
        if (!this.continuations.pause(runId, 'retrying')) throw new Error('Run cannot retry');
        throw new WorkflowSuspended();
      }
      const executor = this.runner.getExecutor(request.type);
      const attempt = this.steps.beginStep({ runId, stepId, nodeType: executor.type, nodeVersion: executor.version, config: request.config, value: request.input });
      try {
        const output = await this.runner.execute<T>({ runId, stepId, attemptId: attempt.attemptId, signal }, request);
        this.steps.finishStep({ stepRunId: attempt.stepRunId, attemptId: attempt.attemptId, status: "succeeded", output });
        return output;
      } catch (error) {
        const timedOut = signal.aborted && signal.reason instanceof WorkflowTimeoutError;
        const status = signal.aborted && !timedOut ? "cancelled" : "failed";
        this.steps.finishStep({ stepRunId: attempt.stepRunId, attemptId: attempt.attemptId, status, error: { message: error instanceof Error ? error.message : String(error), ...(timedOut ? { code: "WORKFLOW_TIMEOUT", timeoutMs: signal.reason.timeoutMs, retryable: true } : {}) } });
        const retryable = !(error && typeof error === 'object' && 'retryable' in error && error.retryable === false);
        if ((!signal.aborted || timedOut) && retryable && retry && attempt.attemptNo < retry.maxAttempts) {
          const delay = Math.min(retry.maxDelayMs ?? 60_000, (retry.initialDelayMs ?? 250) * (retry.backoff === 'fixed' ? 1 : 2 ** (attempt.attemptNo - 1)));
          const resumeAt = Date.now() + delay;
          this.continuations.create({ runId, stepKey: `${stepId}:retry:${attempt.attemptNo}`, kind: 'retry', resumeAt, payload: { stepId }, idempotencyKey: `${runId}:${stepId}:retry:${attempt.attemptNo}` });
          if (this.continuations.pause(runId, 'retrying')) {
            new RunRepository(this.db).appendEvent({ runId, stepId, attemptId: attempt.attemptId, type: 'step.retrying', payload: { resumeAt, attemptNo: attempt.attemptNo } });
            throw new WorkflowSuspended();
          }
        }
        throw error;
      }
  }
}
