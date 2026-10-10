
export type Runner = (args: string[], options?: { deadline?: number }) => Promise<unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type HistoryRecord = Record<string, unknown> & { id: number; status: string };

async function history(run: Runner, taskId: number, deadline = Date.now() + 120_000): Promise<HistoryRecord[]> {
  const records: HistoryRecord[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 100; page++) {
    if (Date.now() >= deadline) throw new Error("Task history query deadline exceeded");
    const result = await run(["task", "history", "--id", String(taskId), "--page", String(page), "--size", "100"], { deadline });
    if (!isRecord(result) || !Array.isArray(result.records) ||
        !Number.isSafeInteger(result.total) || (result.total as number) < 0) {
      throw new Error("Invalid task history page");
    }
    for (const item of result.records) {
      if (!isRecord(item) || !Number.isSafeInteger(item.id) || (item.id as number) <= 0 ||
          typeof item.status !== "string" || Number(item.scheduleTaskId) !== taskId) {
        throw new Error("Invalid task history record");
      }
      if (seen.has(item.id as number)) {
        throw new Error("Task history changed during pagination; refusing an ambiguous snapshot");
      }
      seen.add(item.id as number);
      records.push(item as HistoryRecord);
    }
    if (records.length >= (result.total as number)) return records;
    if (!result.records.length) throw new Error("Incomplete task history");
  }
  throw new Error("Task history exceeds pagination limit");
}

export async function historyBaseline(run: Runner, taskId: number): Promise<number> {
  const records = await history(run, taskId);
  return records.reduce((max, record) => Math.max(max, record.id), 0);
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return isRecord(value) ? value : undefined;
}

export type PollResult =
  | { state: "waiting"; executionId: number | null }
  | { state: "completed"; executionId: number; output: string };

export async function pollTask(
  baseline: number,
  executionId: number | null,
  run: Runner,
  taskId: number,
  maxOutputBytes = 1024 * 1024,
  deadline = Date.now() + 120_000,
): Promise<PollResult> {
  if (!Number.isSafeInteger(baseline) || baseline < 0 ||
      (executionId !== null && (!Number.isSafeInteger(executionId) || executionId <= baseline))) {
    throw new Error("Invalid execution correlation; refusing to read an unrelated result");
  }
  const records = await history(run, taskId, Math.min(deadline, Date.now() + 120_000));
  const candidates = records.filter((record) => record.id > baseline);
  // Without a server-provided execution ID we must not guess among concurrent runs.
  if (executionId === null && candidates.length > 1) {
    throw new Error("Multiple new executions found; cannot identify this submission safely");
  }
  const record = executionId === null
    ? candidates[0]
    : records.find((item) => item.id === executionId);
  if (!record) {
    if (executionId !== null) throw new Error("Tracked execution disappeared from task history");
    return { state: "waiting", executionId: null };
  }

  const status = typeof record.businessStatus === "string" ? record.businessStatus : record.status;
  if (["error", "failed", "terminated", "cancelled", "canceled", "partial_success", "skipped", "disabled"].includes(status)) {
    throw new Error(`Metric execution ${record.id} ended with status ${status}`);
  }
  if (!["success", "close"].includes(status)) {
    if (!["pending", "prepared", "running", "open", "processing", "retry", "waiting"].includes(status)) {
      throw new Error(`Unknown status for metric execution ${record.id}`);
    }
    return { state: "waiting", executionId: record.id };
  }

  const response = parseObject(record.responseData);
  const data = parseObject(response?.data);
  const dbt = parseObject(data?.dbt);
  if (response?.success === false || data?.success === false || dbt?.success === false ||
      (typeof dbt?.exitCode === "number" && dbt.exitCode !== 0)) {
    throw new Error(`Metric execution ${record.id} reported a failed dbt result`);
  }
  if (typeof dbt?.output !== "string") {
    throw new Error(`Metric execution ${record.id} has no responseData.data.dbt.output; check metric-cli responseData normalization`);
  }
  // Reject oversized output instead of silently truncating logs.
  if (Buffer.byteLength(JSON.stringify(dbt.output), "utf8") > maxOutputBytes) {
    throw new Error(`Metric execution ${record.id} output exceeds the configured limit; external artifact storage is required`);
  }
  return { state: "completed", executionId: record.id, output: dbt.output };
}
