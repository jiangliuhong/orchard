export interface TaskEnvelope { readonly taskId: string; readonly runId: string; readonly attemptId: string; readonly workflowVersionId: string; readonly stepKey: string; readonly payload?: unknown; }
export interface LeaseEnvelope { readonly leaseId: string; readonly workerId: string; readonly leaseVersion: number; readonly expiresAt: number; }
export interface TaskClaim { readonly task: TaskEnvelope; readonly lease: LeaseEnvelope; }
export interface TaskError { readonly code?: string; readonly message: string; readonly retryable?: boolean; readonly details?: unknown; }
export interface TaskResult { readonly workerId: string; readonly taskId: string; readonly runId: string; readonly attemptId: string; readonly leaseId: string; readonly leaseVersion: number; readonly status: "succeeded" | "failed" | "cancelled"; readonly output?: unknown; readonly error?: TaskError; }
export interface WorkerHealth { readonly workerId: string; readonly active: number; readonly queueDepth: number; readonly leases: number; readonly lastRecoveryAt?: number; }

export function assertTaskResult(result: TaskResult): void {
  if (!result.workerId || !result.taskId || !result.runId || !result.attemptId || !result.leaseId) throw new Error("Task result is missing an identity field");
  if (!Number.isInteger(result.leaseVersion) || result.leaseVersion < 1) throw new Error("Task result has invalid lease version");
  if (!["succeeded", "failed", "cancelled"].includes(result.status)) throw new Error("Task result has invalid status");
  if (result.status === "failed" && !result.error?.message) throw new Error("Failed task result requires error context");
}
