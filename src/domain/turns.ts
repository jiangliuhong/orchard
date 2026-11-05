import { check } from "./errors.js";
import type { AuthoringTurnStatus, SubmissionState } from "./types.js";

export const ACTIVE_TURN_STATUSES = ["queued", "running", "cancel_requested"] as const;
const statuses: readonly string[] = [...ACTIVE_TURN_STATUSES, "succeeded", "failed", "cancelled", "interrupted"];
export const isActiveTurn = (status: string) => (ACTIVE_TURN_STATUSES as readonly string[]).includes(status);
export function assertTurnStatus(status: string): asserts status is AuthoringTurnStatus {
  check(statuses.includes(status), "INVALID_TURN_STATUS", "轮次状态无效");
}
export function assertSubmissionState(state: string): asserts state is SubmissionState {
  check(["not_sent", "sending", "accepted", "settled"].includes(state), "INVALID_SUBMISSION_STATE", "提交状态无效");
}
const transitions: Record<AuthoringTurnStatus, readonly AuthoringTurnStatus[]> = {
  queued: ["running", "failed", "cancelled", "interrupted"],
  running: ["cancel_requested", "succeeded", "failed", "interrupted"],
  cancel_requested: ["cancelled", "failed", "interrupted"],
  succeeded: [], failed: [], cancelled: [], interrupted: [],
};
export function assertTurnTransition(from: AuthoringTurnStatus, to: AuthoringTurnStatus): void {
  check(transitions[from].includes(to), "INVALID_TURN_TRANSITION", `不允许轮次状态从 ${from} 转换为 ${to}`);
}
