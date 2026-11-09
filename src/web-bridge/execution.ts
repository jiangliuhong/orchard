import { allowsRequestBody, type BridgeHttpMethod } from "./http-methods.js";
import { BROWSER_EXECUTION_SCHEMA, type BrowserExecution } from "./browser-execution.js";
import { validatePath } from "./request-path.js";
export { validatePath } from "./request-path.js";
import { createHash, randomBytes } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { JsonSchema } from "../domain/types.js";
import { postprocessResponse, RESPONSE_POSTPROCESS_SCHEMA, type ResponsePostprocess } from "./postprocess.js";

/** Explicit opt-in: local HTTP, not browser cookies or page execution. */
export interface BridgeHttpExecution {
  version: 1;
  transport: "localHttp";
  body?: { mode: "rawUtf8" | "json"; argument: string };
  signing?: {
    algorithm: "md5";
    dictionaryId: string;
    akKey: string;
    skKey: string;
    parts: ("ak" | "sk" | "nonce" | "timestamp" | "body" | "path")[];
    separator: string;
    digestCase: "lower" | "upper";
    nonceBytes: number;
    timestampUnit: "seconds" | "milliseconds";
    clock?: { path: string; field: string; unit: "seconds" | "milliseconds" };
    headers: { ak: string; nonce: string; timestamp: string; signature: string };
  };
  response: { mode: "fields" | "fullJson"; maxBytes: number };
  postprocess?: ResponsePostprocess;
}
const argument = { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,99}$" };
const header = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9-]{0,99}$" };
const LOCAL_HTTP_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["version", "transport", "response"],
  properties: {
    version: { const: 1 }, transport: { const: "localHttp" },
    postprocess: RESPONSE_POSTPROCESS_SCHEMA,
    body: { type: "object", additionalProperties: false, required: ["mode", "argument"], properties: { mode: { enum: ["rawUtf8", "json"] }, argument } },
    signing: {
      type: "object", additionalProperties: false,
      required: ["algorithm", "dictionaryId", "akKey", "skKey", "parts", "separator", "digestCase", "nonceBytes", "timestampUnit", "headers"],
      properties: {
        algorithm: { const: "md5" }, dictionaryId: { type: "string", minLength: 1, maxLength: 100 }, akKey: argument, skKey: argument,
        parts: { type: "array", minItems: 1, maxItems: 20, items: { enum: ["ak", "sk", "nonce", "timestamp", "body", "path"] } },
        separator: { type: "string", maxLength: 100 }, digestCase: { enum: ["lower", "upper"] },
        nonceBytes: { type: "integer", minimum: 8, maximum: 64 }, timestampUnit: { enum: ["seconds", "milliseconds"] },
        clock: { type: "object", additionalProperties: false, required: ["path", "field", "unit"], properties: { path: { type: "string", minLength: 2 }, field: argument, unit: { enum: ["seconds", "milliseconds"] } } },
        headers: { type: "object", additionalProperties: false, required: ["ak", "nonce", "timestamp", "signature"], properties: { ak: header, nonce: header, timestamp: header, signature: header } },
      },
    },
    response: { type: "object", additionalProperties: false, required: ["mode", "maxBytes"], properties: { mode: { enum: ["fields", "fullJson"] }, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } } },
  },
};

export const BRIDGE_HTTP_SCHEMA: JsonSchema = { anyOf: [LOCAL_HTTP_SCHEMA, BROWSER_EXECUTION_SCHEMA] };
export type BridgeExecution = BridgeHttpExecution | BrowserExecution;

const forbiddenHeaders = new Set(["host", "cookie", "origin", "referer", "content-type", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization"]);
export function validateHttpDefinition(path: string, method: string, execution: BridgeExecution, parameters: JsonSchema) {
  validatePath(path, execution.transport === "localHttp");
  if (execution.transport === "browser") return;
  const properties = typeof parameters === "object" ? parameters.properties as Record<string, unknown> | undefined : undefined;
  for (const match of path.matchAll(/\{([^}]+)\}/g)) check(properties && Object.hasOwn(properties, match[1]), "INVALID_PATH", "路径占位符必须声明为参数");
  if (execution.body) {
    check(allowsRequestBody(method), "INVALID_BODY", "GET 和 HEAD 不支持请求体映射");
    check(properties && Object.hasOwn(properties, execution.body.argument), "INVALID_BODY", "请求体参数未声明");
  }
  const signing = execution.signing;
  if (signing) {
    check(signing.parts.includes("sk"), "INVALID_SIGNING", "签名必须包含密钥");
    if (signing.clock) validatePath(signing.clock.path);
    const names = Object.values(signing.headers).map(name => name.toLowerCase());
    check(new Set(names).size === names.length && names.every(name => !forbiddenHeaders.has(name) && !name.startsWith("sec-") && !name.startsWith("proxy-")), "INVALID_SIGNING", "鉴权头重复或使用了保留请求头");
  }
}

export function validateStoredHttpTool(tool: { path: string; method: string; parameters: JsonSchema; execution?: BridgeExecution }) {
  if (!tool.execution) return;
  assertSchema(tool.execution, BRIDGE_HTTP_SCHEMA, "HTTP 执行配置");
  validateHttpDefinition(tool.path, tool.method, tool.execution, tool.parameters);
}

export interface HttpTool { path: string; method: BridgeHttpMethod; fields: string[]; execution: BridgeHttpExecution }
export type CredentialResolver = (dictionaryId: string, key: string) => string;
export interface HttpDependencies {
  fetch?: typeof fetch;
  resolveCredential?: CredentialResolver;
  now?: () => number;
  nonce?: (bytes: number) => string;
}
function target(origin: string, path: string) {
  validatePath(path);
  let base: URL;
  try { base = new URL(origin); } catch { throw new AppError("INVALID_ORIGIN", "环境 origin 无效"); }
  check(base.origin === origin && !base.username && !base.password && (base.protocol === "https:" || (base.protocol === "http:" && ["127.0.0.1", "localhost"].includes(base.hostname))), "INVALID_ORIGIN", "环境必须是 HTTPS origin 或本机 HTTP");
  const url = new URL(path, base);
  check(url.origin === base.origin && url.pathname === path, "INVALID_PATH", "请求路径发生了规范化");
  return url;
}
async function readJson(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    check(response.ok && !response.redirected, "HTTP_REQUEST_FAILED", "上游返回非成功状态或重定向");
    if (response.status === 204 || response.status === 205) return null;
    check(Number(response.headers.get("content-length") ?? 0) <= limit, "RESPONSE_TOO_LARGE", "响应超过大小限制");
    check(reader, "INVALID_RESPONSE", "上游响应为空");
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      check(size <= limit, "RESPONSE_TOO_LARGE", "响应超过大小限制");
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw new AppError("INVALID_RESPONSE", "上游未返回有效 JSON"); }
  } finally { await reader?.cancel().catch(() => {}); }
}

export async function executeHttpTool(tool: HttpTool, origin: string, args: Record<string, unknown>, signal: AbortSignal, dependencies: HttpDependencies = {}) {
  check(args !== null && typeof args === "object" && !Array.isArray(args), "INVALID_ARGUMENT", "HTTP 执行参数必须是对象");
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const execution = tool.execution;
  const path = tool.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
    check(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)), "INVALID_ARGUMENT", "动态路径参数必须是字符串或有限数值");
    const segment = String(value);
    check(segment.length > 0 && segment !== "." && segment !== ".." && !/[\\/%\u0000-\u0020\u007f]/.test(segment), "INVALID_ARGUMENT", "动态路径参数包含不安全字符");
    return encodeURIComponent(segment);
  });
  const url = target(origin, path);
  let body: string | undefined;
  if (execution.body) {
    check(Object.hasOwn(args, execution.body.argument), "INVALID_BODY", "缺少请求体参数");
    const value = args[execution.body.argument];
    if (execution.body.mode === "rawUtf8") {
      check(typeof value === "string", "INVALID_BODY", "原始请求体必须是 UTF-8 字符串");
      body = value;
      check(Buffer.from(body, "utf8").toString("utf8") === body, "INVALID_BODY", "请求体包含无效 Unicode");
    } else body = JSON.stringify(value);
    check(body !== undefined && Buffer.byteLength(body) <= 262144, "INVALID_BODY", "请求体无效或超过大小限制");
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
  const signing = execution.signing;
  const secrets: string[] = [];
  try {
    signal.throwIfAborted();
    if (signing) {
      check(dependencies.resolveCredential, "CREDENTIAL_UNAVAILABLE", "未配置安全凭据解析器");
      const ak = dependencies.resolveCredential(signing.dictionaryId, signing.akKey);
      const sk = dependencies.resolveCredential(signing.dictionaryId, signing.skKey);
      check(ak.length > 0 && sk.length > 0 && !/[\r\n\u0000]/.test(ak), "INVALID_CREDENTIAL", "凭据为空或格式无效");
      secrets.push(ak, sk);
      let timestampMs = now();
      if (signing.clock) {
        const start = now();
        const clockResponse = await request(target(origin, signing.clock.path), { method: "GET", redirect: "error", credentials: "omit", signal });
        const clock = await readJson(clockResponse, 16384, signal) as Record<string, unknown> | null;
        const value = clock && typeof clock === "object" && !Array.isArray(clock) && Object.hasOwn(clock, signing.clock.field) ? clock[signing.clock.field] : undefined;
        check(typeof value === "number" && Number.isFinite(value) && value > 0, "INVALID_CLOCK", "校时接口未返回有效数值时间戳");
        timestampMs = value * (signing.clock.unit === "seconds" ? 1000 : 1) + (now() - start) / 2;
      }
      const timestamp = String(Math.floor(timestampMs / (signing.timestampUnit === "seconds" ? 1000 : 1)));
      const nonce = (dependencies.nonce ?? (bytes => randomBytes(bytes).toString("hex")))(signing.nonceBytes);
      const sources = { ak, sk, nonce, timestamp, body: body ?? "", path };
      let signature = createHash("md5").update(signing.parts.map(part => sources[part]).join(signing.separator), "utf8").digest("hex");
      if (signing.digestCase === "upper") signature = signature.toUpperCase();
      for (const key of ["ak", "nonce", "timestamp"] as const) headers[signing.headers[key]] = sources[key];
      headers[signing.headers.signature] = signature;
      secrets.push(signature);
    }
    const response = await request(url, { method: tool.method, headers, body, redirect: "error", credentials: "omit", signal });
    const result = tool.method === "HEAD"
      ? (check(response.ok && !response.redirected, "HTTP_REQUEST_FAILED", "上游返回非成功状态或重定向"), null)
      : await readJson(response, execution.response.maxBytes, signal);
    // Refuse upstream credential echoes before results can enter workflow history/logs.
    const serialized = JSON.stringify(result);
    check(!secrets.some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))), "SENSITIVE_RESPONSE", "上游响应包含鉴权信息，已阻止返回");
    if (execution.response.mode === "fullJson" || result === null) return await postprocessResponse(execution.postprocess, result, args, signal, execution.response.maxBytes, secrets);
    check(result !== null && typeof result === "object" && !Array.isArray(result), "INVALID_RESPONSE", "字段白名单要求对象响应");
    const selected = Object.fromEntries(tool.fields.filter(field => Object.hasOwn(result, field)).map(field => [field, (result as Record<string, unknown>)[field]]));
    return await postprocessResponse(execution.postprocess, selected, args, signal, execution.response.maxBytes, secrets);
  } catch (error) {
    if (signal.aborted) throw signal.reason?.name === "TimeoutError" ? new AppError("HTTP_TIMEOUT", "HTTP 调用超时") : new AppError("CANCELLED", "HTTP 调用已取消");
    if (error instanceof AppError) throw error;
    // fetch and crypto errors can contain URLs, request headers or credentials.
    throw new AppError("HTTP_EXECUTION_FAILED", "本机 HTTP 执行失败，请检查环境与签名配置");
  }
}
