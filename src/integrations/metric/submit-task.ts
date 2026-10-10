import { historyBaseline, isRecord, type Runner } from "./task-history.js";

export interface MetricTaskConfig {
  readonly profile: string;
  readonly projectId: number;
  readonly taskId: number;
  readonly taskName: string;
  readonly model: string;
}

export async function submitTask(targetTask: MetricTaskConfig, run: Runner) {
  const deadline = Date.now() + 120_000;
  const command: Runner = (args) => run(args, { deadline });
  // Verify the fixed ID still belongs to the intended project/name/model before writing.
  let found = false;
  for (let page = 1; page <= 100; page++) {
    const result = await command([
      "task", "list", "--project-id", String(targetTask.projectId),
      "--page", String(page), "--size", "100",
    ]);
    if (!isRecord(result) || !Array.isArray(result.records) ||
        typeof result.total !== "number" || !Number.isFinite(result.total) || result.total < 0) {
      throw new Error("Invalid metric-cli task list response");
    }
    const task = result.records.find((item: unknown) => isRecord(item) && item.id === targetTask.taskId);
    if (task) {
      if (task.projectId !== targetTask.projectId || task.name !== targetTask.taskName ||
          task.target !== targetTask.model || task.type !== "model") {
        throw new Error("Task identity changed; refusing to run");
      }
      if (task.currentExecution != null) {
        throw new Error("Task already has a current execution; check task history before retrying");
      }
      found = true;
      break;
    }
    if (result.records.length === 0 || page * 100 >= result.total) break;
  }
  if (!found) throw new Error("Target task not found; refusing to run");

  const baseline = await historyBaseline(command, targetTask.taskId);
  await command(["task", "run", "--id", String(targetTask.taskId)]);
  return {
    ...targetTask,
    status: "submitted" as const,
    baseline,
    deadline: Date.now() + 30 * 60 * 1000,
  };
}
