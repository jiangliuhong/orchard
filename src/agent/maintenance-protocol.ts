import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { projectionSegment } from "./workspace-projection.js";

export const MAINTENANCE_CONTRACT = "orchard.maintenance.v1";
export type MaintenanceTarget = { kind: "workflow_draft"; id: string; scope: { draftId: string } }
  | { kind: "script_draft"; id: string; scope: { draftVersionId: string | null } }
  | { kind: "browser_application"; id: string; scope: Record<string, never> };
export interface MaintenanceProposalInput {
  contractVersion: typeof MAINTENANCE_CONTRACT; requestId: string; summary: string;
  target: MaintenanceTarget; baseline: Record<string, unknown>; change: Record<string, unknown>;
}
export function assertTarget(value: unknown): asserts value is MaintenanceTarget {
  assertSchema(value, { type: "object", required: ["kind", "id", "scope"], additionalProperties: false, properties: {
    kind: { enum: ["workflow_draft", "script_draft", "browser_application"] }, id: { type: "string", minLength: 1, maxLength: 200 }, scope: { type: "object" },
  } }, "维护目标");
  const target = value as MaintenanceTarget; projectionSegment(target.id);
  const properties = target.kind === "workflow_draft" ? { draftId: { type: "string", minLength: 1, maxLength: 200 } }
    : target.kind === "script_draft" ? { draftVersionId: { anyOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 200 }] } } : {};
  assertSchema(target.scope, { type: "object", required: Object.keys(properties), additionalProperties: false, properties }, "维护目标范围");
}
export function assertProposalInput(value: unknown): asserts value is MaintenanceProposalInput {
  assertSchema(value, { type: "object", required: ["contractVersion", "requestId", "summary", "target", "baseline", "change"], additionalProperties: false, properties: {
    contractVersion: { const: MAINTENANCE_CONTRACT }, requestId: { type: "string", minLength: 1, maxLength: 200 }, summary: { type: "string", minLength: 1, maxLength: 4000 },
    target: { type: "object" }, baseline: { type: "object" }, change: { type: "object" },
  } }, "维护提案");
  assertTarget((value as MaintenanceProposalInput).target);
}
export function onlyKeys(value: unknown, allowed: string[], required = allowed): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
    "INVALID_PROPOSAL", "提案包含未知字段或缺少必需字段");
}
