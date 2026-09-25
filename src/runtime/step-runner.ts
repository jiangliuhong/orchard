import type { NodeContext, NodeRegistry, StepRequest } from "../workflow-sdk/index.js";
import { assertValidJson } from "../workflow-sdk/index.js";

export interface StepExecutionOptions {
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly signal?: AbortSignal;
  readonly log?: NodeContext["log"];
}

export class StepRunner {
  constructor(private readonly nodes: NodeRegistry) {}

  getExecutor(type: string) { return this.nodes.get(type); }

  async execute<Output = unknown>(options: StepExecutionOptions, request: StepRequest): Promise<Output> {
    const executor = this.nodes.get(request.type);
    assertValidJson(request.config, executor.configSchema, `${request.type} config`);
    assertValidJson(request.input, executor.inputSchema, `${request.type} input`);
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const context: NodeContext = {
      runId: options.runId,
      stepId: options.stepId,
      attemptId: options.attemptId,
      signal,
      log: options.log ?? (() => undefined),
    };
    const output = await executor.execute(context, request.config, request.input);
    signal.throwIfAborted();
    assertValidJson(output, executor.outputSchema, `${request.type} output`);
    return output as Output;
  }
}
