import type { NodeRegistry, StepRequest, WorkflowDefinition } from "../workflow-sdk/index.js";
import { createWorkflowContext, validateWorkflowInput } from "../workflow-sdk/index.js";
import { StepRepository } from "../storage/database.js";
import type { OrchardDatabase } from "../storage/database.js";
import { StepRunner } from "./step-runner.js";

export class WorkflowExecutionService {
  private readonly steps: StepRepository;
  private readonly runner: StepRunner;

  constructor(db: OrchardDatabase, nodes: NodeRegistry) {
    this.steps = new StepRepository(db);
    this.runner = new StepRunner(nodes);
  }

  async execute<Input, Output>(runId: string, workflow: WorkflowDefinition<Input, Output>, input: unknown, signal: AbortSignal): Promise<Output> {
    validateWorkflowInput(workflow, input);
    const context = createWorkflowContext(runId, signal, async <T>(stepId: string, request: StepRequest): Promise<T> => {
      const executor = this.runner.getExecutor(request.type);
      const attempt = this.steps.beginStep({ runId, stepId, nodeType: executor.type, nodeVersion: executor.version, config: request.config, value: request.input });
      try {
        const output = await this.runner.execute<T>({ runId, stepId, attemptId: attempt.attemptId, signal }, request);
        this.steps.finishStep({ stepRunId: attempt.stepRunId, attemptId: attempt.attemptId, status: "succeeded", output });
        return output;
      } catch (error) {
        const status = signal.aborted ? "cancelled" : "failed";
        this.steps.finishStep({ stepRunId: attempt.stepRunId, attemptId: attempt.attemptId, status, error: { message: error instanceof Error ? error.message : String(error) } });
        throw error;
      }
    });
    const output = await workflow.run(context, input);
    signal.throwIfAborted();
    return output;
  }
}
