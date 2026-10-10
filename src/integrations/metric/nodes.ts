import { Type, type NodeContext, type NodeRegistry } from "../../workflow-sdk/index.js";
import { ProcessController } from "../cli/process-controller.js";
import { pollTask, type Runner } from "./task-history.js";
import { submitTask, type MetricTaskConfig } from "./submit-task.js";

class MetricCommandError extends Error {
  readonly retryable = false;
  constructor() {
    super("metric-cli failed. Check installation, authentication and task history before retrying; a submission may already have been accepted.");
  }
}

export type MetricRunnerFactory = (profile: string, context: NodeContext) => Runner;

const controller = new ProcessController();
const runner: MetricRunnerFactory = (profile, context) => async (args, options = {}) => {
  context.signal.throwIfAborted();
  const timeoutMs = Math.min(120_000, (options.deadline ?? Infinity) - Date.now());
  if (timeoutMs <= 0) throw new Error("Metric query deadline exceeded; remote execution is not cancelled");
  let stdout: string;
  try {
    const result = await controller.execute({ executable: "metric-cli", args: ["--profile", profile, "--json", ...args], timeoutMs, maxOutputBytes: 4 * 1024 * 1024, killGraceMs: 2_000 }, { signal: context.signal });
    if (result.exitCode !== 0) throw new MetricCommandError();
    stdout = result.stdout;
  } catch {
    context.signal.throwIfAborted();
    // Raw stdout/stderr can include credentials; never persist them in run logs.
    throw new MetricCommandError();
  }
  try { return JSON.parse(stdout) as unknown; }
  catch { throw new Error("metric-cli returned invalid JSON; check task history before retrying."); }
};

const profile = Type.String({ minLength: 1, maxLength: 100 });
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export function registerMetricNodes(nodes: NodeRegistry, createRunner: MetricRunnerFactory = runner): NodeRegistry {
  nodes.register<MetricTaskConfig, unknown, unknown>({
    type: "metric.task.submit", version: "1", sideEffects: "non_idempotent",
    configSchema: Type.Object({ profile, projectId: id, taskId: id, taskName: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ baseline: Type.Integer({ minimum: 0 }), deadline: Type.Number() }),
    async execute(context, config) {
      try { return await submitTask(config, createRunner(config.profile, context)); }
      catch (error) {
        // A non-idempotent submit must never be automatically repeated after an ambiguous failure.
        throw Object.assign(new Error(error instanceof Error ? error.message : "Metric submission failed"), { retryable: false });
      }
    },
  });
  nodes.register<{ profile: string; taskId: number; maxOutputBytes?: number }, { baseline: number; executionId: number | null; deadline: number }, unknown>({
    type: "metric.task.poll", version: "1", sideEffects: "read_only",
    configSchema: Type.Object({ profile, taskId: id, maxOutputBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1024 * 1024 })) }, { additionalProperties: false }),
    inputSchema: Type.Object({ baseline: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), executionId: Type.Union([id, Type.Null()]), deadline: Type.Number() }, { additionalProperties: false }),
    outputSchema: Type.Union([Type.Object({ state: Type.Literal("waiting"), executionId: Type.Union([id, Type.Null()]) }), Type.Object({ state: Type.Literal("completed"), executionId: id, output: Type.String() })]),
    async execute(context, config, input) {
      const run = createRunner(config.profile, context);
      const read: Runner = async (args, options) => {
        for (let attempt = 0; ; attempt++) {
          context.signal.throwIfAborted();
          try { return await run(args, options); }
          catch (error) { if (!(error instanceof MetricCommandError) || attempt >= 2) throw error; }
        }
      };
      try { return await pollTask(input.baseline, input.executionId, read, config.taskId, config.maxOutputBytes, input.deadline); }
      catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : "Metric polling failed"), { retryable: false }); }
    },
  });
  return nodes;
}
