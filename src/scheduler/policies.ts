import type { RunRepository } from "../storage/repository.js";

export type SchedulingDecision = "create" | "delay" | "merge" | "skip" | "cancel" | "reject";
export interface SchedulingPolicy { readonly priority?: number; readonly concurrency?: number; readonly key?: string; readonly rateLimit?: { limit: number; periodMs: number }; readonly throttle?: { limit: number; periodMs: number; burst?: number }; readonly debounceMs?: number; readonly singleton?: { key: string; mode: "skip" | "cancel" }; }
export interface SchedulingResult { readonly decision: SchedulingDecision; readonly reason: string; readonly retryAt?: number; }

/** Pure policy evaluator; persistence and execution remain in the coordinator. */
export function decideSchedule(policy: SchedulingPolicy, input: { active: number; activeForKey?: number; now?: number; lastAcceptedAt?: number; recentAccepted?: readonly number[] }): SchedulingResult {
  const now = input.now ?? Date.now();
  if (policy.concurrency !== undefined && input.active >= policy.concurrency) return { decision: "delay", reason: "concurrency_limit" };
  if (policy.key && policy.concurrency !== undefined && (input.activeForKey ?? 0) >= policy.concurrency) return { decision: "delay", reason: "key_concurrency_limit" };
  if (policy.rateLimit) {
    const recent = (input.recentAccepted ?? []).filter((at) => at > now - policy.rateLimit!.periodMs);
    if (recent.length >= policy.rateLimit.limit) return { decision: "delay", reason: "rate_limit", retryAt: Math.min(...recent) + policy.rateLimit.periodMs };
  }
  if (policy.throttle && input.lastAcceptedAt !== undefined && now - input.lastAcceptedAt < policy.throttle.periodMs / policy.throttle.limit) return { decision: "delay", reason: "throttle", retryAt: input.lastAcceptedAt + Math.ceil(policy.throttle.periodMs / policy.throttle.limit) };
  if (policy.debounceMs && input.lastAcceptedAt !== undefined && now - input.lastAcceptedAt < policy.debounceMs) return { decision: "merge", reason: "debounce", retryAt: input.lastAcceptedAt + policy.debounceMs };
  return { decision: "create", reason: "accepted" };
}

export function singletonDecision(policy: SchedulingPolicy["singleton"], active: boolean): SchedulingResult {
  if (!policy || !active) return { decision: "create", reason: "accepted" };
  return policy.mode === "skip" ? { decision: "skip", reason: "singleton_active" } : { decision: "cancel", reason: "singleton_replaced" };
}

export function recordSchedulingDecision(runs: RunRepository, runId: string, result: SchedulingResult, policyKey?: string): string {
  return runs.recordSchedulingDecision({ runId, decision: result.decision, reason: result.reason, ...(policyKey === undefined ? {} : { policyKey }), ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }) });
}
