import { check } from "../domain/errors.js";
import type { JsonSchema } from "../domain/types.js";
import { BRIDGE_HTTP_METHODS, allowsRequestBody, type BridgeHttpMethod } from "./http-methods.js";
import { validatePath } from "./request-path.js";

const identifier = "^[A-Za-z][A-Za-z0-9_]{0,63}$";
const text: JsonSchema = { type: "string", maxLength: 8192 };
const selector: JsonSchema = {
  type: "array", minItems: 1, maxItems: 8,
  items: { type: "string", minLength: 1, maxLength: 128 },
};
const strings = (maxLength: number): JsonSchema => ({
  type: "object", maxProperties: 32, propertyNames: { minLength: 1, maxLength: 128, pattern: "^[^\\x00-\\x1f\\x7f]+$" }, additionalProperties: { type: "string", maxLength },
});
const object = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object", additionalProperties: false, properties, required,
});
const captures: JsonSchema = {
  type: "object", maxProperties: 16, propertyNames: { pattern: identifier },
  additionalProperties: object({
    at: selector, secret: { type: "boolean" }, optional: { type: "boolean" },
    match: object({
      field: selector, equalsFrom: { type: "string", pattern: identifier }, value: selector,
    }, ["field", "equalsFrom", "value"]),
    positiveInteger: { type: "boolean" },
  }, ["at"]),
};
const statuses: JsonSchema = { type: "array", minItems: 1, maxItems: 16, items: text };
export const BROWSER_FLOW_SCHEMA: JsonSchema = object({
  capture: captures,
  steps: {
    type: "array", minItems: 1, maxItems: 8,
    items: object({
      path: { type: "string", minLength: 2, maxLength: 2048 },
      method: { enum: [...BRIDGE_HTTP_METHODS] },
      headers: strings(8192), query: strings(8192),
      bodyFrom: { type: "string", pattern: identifier },
      jsonFields: { type: "object", minProperties: 1, maxProperties: 32, propertyNames: { pattern: identifier },
        additionalProperties: object({ from: { type: "string", pattern: identifier }, type: { enum: ["string", "positiveInteger"] } }, ["from", "type"]) },
      when: { type: "string", pattern: identifier },
      capture: captures,
      poll: object({
        at: selector, success: statuses, failure: statuses,
        intervalMs: { type: "integer", minimum: 100, maximum: 10000 },
        maxAttempts: { type: "integer", minimum: 1, maximum: 120 },
      }, ["at", "success", "failure", "intervalMs", "maxAttempts"]),
    }, ["path", "method"]),
  },
}, ["steps"]);

type Captures = Record<string, {
  at: string[]; secret?: boolean; optional?: boolean; positiveInteger?: boolean;
  match?: { field: string[]; equalsFrom: string; value: string[] };
}>;
export interface BrowserFlow {
  capture?: Captures;
  steps: {
    path: string; method: BridgeHttpMethod;
    headers?: Record<string, string>; query?: Record<string, string>;
    bodyFrom?: string; jsonFields?: Record<string, { from: string; type: "string" | "positiveInteger" }>;
    when?: string; capture?: Captures;
    poll?: { at: string[]; success: string[]; failure: string[]; intervalMs: number; maxAttempts: number };
  }[];
}

export function validBrowserHeader(name: string) {
  return /^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(name) &&
    !/^(cookie|host|origin|referer|content-length|connection|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i.test(name);
}

export function validateBrowserFlow(flow: BrowserFlow) {
  check(!flow.steps[0]?.when, "INVALID_BROWSER_FLOW", "浏览器请求链首个后续步骤必须执行");
  const names = new Set<string>();
  for (const capture of [flow.capture, ...flow.steps.map(step => step.capture)]) {
    for (const [name, spec] of Object.entries(capture ?? {})) {
      check(!spec.match || !spec.optional, "INVALID_BROWSER_FLOW", "按值匹配的捕获必须得到唯一结果");
      check(!names.has(name), "INVALID_BROWSER_FLOW", "浏览器请求链变量不能重复捕获");
      names.add(name);
    }
  }
  for (const step of flow.steps) {
    validatePath(step.path, true);
    check(Object.keys(step.headers ?? {}).every(validBrowserHeader), "INVALID_HEADERS", "浏览器请求链使用了保留或无效请求头");
    check(!step.bodyFrom || allowsRequestBody(step.method), "INVALID_BODY", "当前请求方法不支持请求体");
    check(!step.jsonFields || step.bodyFrom, "INVALID_BODY", "jsonFields 需要通过 bodyFrom 提供 JSON 对象");
    if (step.poll) {
      check(step.method === "GET", "INVALID_BROWSER_FLOW", "浏览器轮询仅支持 GET");
      const success = new Set(step.poll.success.map(status => status.toLowerCase()));
      check(step.poll.failure.every(status => !success.has(status.toLowerCase())), "INVALID_BROWSER_FLOW", "轮询成功和失败状态不能重叠");
    }
  }
}
