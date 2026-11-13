import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppError, check } from "../domain/errors.js";
import type { JsonSchema } from "../domain/types.js";
import type { CredentialResolver } from "./execution.js";
import { validatePath } from "./request-path.js";
import { CREDENTIAL_INPUTS_SCHEMA, resolveCredentialInputs, type CredentialBindings } from "./credential-inputs.js";
import { credentialSchema, credentialProperties, credentialRequired } from "./credential-schema.js";
import { assertSchema } from "../domain/validation.js";
import { RESPONSE_POSTPROCESS_SCHEMA, type ResponsePostprocess } from "./postprocess.js";

export interface BrowserExecution {
  version: 1;
  transport: "browser";
  signing?: never;
  credentialInputs?: string[];
  credentialSchema?: JsonSchema;
  preprocess: { runtime: "nodejs"; code: string; credentials?: Record<string, { dictionaryId: string; key: string }> };
  response: { mode: "fields" | "fullJson"; maxBytes: number };
  postprocess?: ResponsePostprocess;
}
export const BROWSER_EXECUTION_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["version", "transport", "preprocess", "response"],
  properties: {
    version: { const: 1 }, transport: { const: "browser" }, credentialInputs: CREDENTIAL_INPUTS_SCHEMA,
    credentialSchema: { type: "object", required: ["type", "properties", "additionalProperties"], properties: {
      type: { const: "object" }, additionalProperties: { const: false },
      properties: { type: "object", maxProperties: 20, propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" }, additionalProperties: { type: "object", required: ["type"], properties: { type: { const: "string" } } } },
      required: CREDENTIAL_INPUTS_SCHEMA,
    } },
    postprocess: RESPONSE_POSTPROCESS_SCHEMA,
    preprocess: { type: "object", additionalProperties: false, required: ["runtime", "code"], properties: {
      runtime: { const: "nodejs" }, code: { type: "string", minLength: 1, maxLength: 65536 },
      credentials: { type: "object", maxProperties: 20, additionalProperties: { type: "object", additionalProperties: false, required: ["dictionaryId", "key"], properties: { dictionaryId: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } } } },
    } },
    response: { type: "object", additionalProperties: false, required: ["mode", "maxBytes"], properties: { mode: { enum: ["fields", "fullJson"] }, maxBytes: { type: "integer", minimum: 1, maximum: 262144 } } },
  },
};
import { BRIDGE_HTTP_METHODS, allowsRequestBody, type BridgeHttpMethod } from "./http-methods.js";

export interface BrowserRequest { path: string; method: BridgeHttpMethod; headers: Record<string, string>; body?: string }

// Reviewed code only. Node permission mode denies filesystem/child-process access;
// this is process isolation, not a sandbox for hostile code.
export async function preprocessBrowser(execution: BrowserExecution, args: unknown, defaults: { path: string; method: string }, signal: AbortSignal, resolve?: CredentialResolver, bindings?: CredentialBindings) {
  const credentials = resolveCredentialInputs(Object.keys(credentialProperties(execution)), execution.preprocess.credentials ?? {}, bindings, resolve, credentialRequired(execution));
  try { assertSchema(credentials, credentialSchema(execution), "调用凭据"); }
  catch { throw new AppError("INVALID_CREDENTIALS", "调用凭据不符合 credentialSchema，请检查必填项、长度和格式"); }
  const source = `import * as crypto from 'node:crypto';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const {args,credentials,request}=JSON.parse(input);
const value=await (async (args,credentials,request,crypto)=>{${execution.preprocess.code}\n})(args,credentials,request,crypto);
process.stdout.write(JSON.stringify(value));`;
  const raw = await new Promise<string>((resolveResult, reject) => {
    signal.throwIfAborted();
    const child = spawn(process.execPath, ["--permission", "--max-old-space-size=64", "--input-type=module", "-e", source], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const fail = () => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new AppError(signal.aborted ? "CANCELLED" : "PREPROCESS_FAILED", "请求预处理失败或超时")); } };
    signal.addEventListener("abort", fail, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { size += Buffer.byteLength(chunk); if (size > 524288) fail(); else output += chunk.toString(); });
    child.stderr.resume();
    child.on("error", fail);
    child.on("close", code => { signal.removeEventListener("abort", fail); if (settled) return; if (code !== 0) return fail(); settled = true; resolveResult(output); });
    child.stdin.on("error", fail);
    child.stdin.end(JSON.stringify({ args, credentials, request: defaults }));
  });
  let request: BrowserRequest;
  try { request = JSON.parse(raw); } catch { throw new AppError("INVALID_REQUEST", "脚本必须返回请求 JSON"); }
  check(request && typeof request === "object", "INVALID_REQUEST", "脚本必须返回请求对象");
  validatePath(request.path);
  check(BRIDGE_HTTP_METHODS.includes(request.method) && request.method === defaults.method, "INVALID_REQUEST", "脚本不能改变已审阅的请求方法");
  check(request.headers && typeof request.headers === "object" && !Array.isArray(request.headers), "INVALID_HEADERS", "脚本必须返回 headers 对象");
  for (const [name, value] of Object.entries(request.headers)) {
    check(/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(name) && !/^(cookie|host|origin|referer|content-length|connection|transfer-encoding|upgrade|proxy-.*|sec-.*)$/i.test(name) && typeof value === "string" && value.length <= 8192 && !/[\r\n\u0000]/.test(value), "INVALID_HEADERS", "脚本返回了保留或无效请求头");
  }
  check(request.body === undefined || (allowsRequestBody(request.method) && typeof request.body === "string" && Buffer.byteLength(request.body) <= 262144 && Buffer.from(request.body).toString() === request.body), "INVALID_BODY", "脚本请求体必须是有效 UTF-8 字符串");
  return { request, secrets: [...Object.values(credentials), ...Object.entries(request.headers).filter(([name]) => /authorization|signature|token|api-key/i.test(name)).map(([, value]) => value)] };
}

const tabErrors = new Map([
  ["TAB_REQUIRED", "请打开并授权桥接站点，检查主桥接页签是否可用"],
  ["TAB_SELECTION_REQUIRED", "请在 Orchard Web Bridge 扩展中选择主桥接页签"],
  ["TAB_DISCARDED", "主桥接页签已被浏览器回收，请切换到该页签恢复"],
  ["TAB_FROZEN", "主桥接页签已被冻结，请切换到该页签恢复"],
]);

export class BrowserChannel {
  private sessions = new Map<string, { token: string; extensionId: string }>();
  private pending = new Map<string, { profileId: string; payload: unknown; delivered: boolean; resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  status() { return { pending: this.pending.size }; }
  register(profileId: string, extensionId: string) {
    const previous = this.sessions.get(profileId);
    const token = previous?.extensionId === extensionId ? previous.token : randomUUID();
    this.sessions.set(profileId, { token, extensionId }); return token;
  }
  authenticate(profileId: string, token: unknown, origin: string | undefined) {
    const session = this.sessions.get(profileId);
    check(session && token === session.token && (!origin || origin === `chrome-extension://${session.extensionId}`), "UNAUTHORIZED", "浏览器通道认证失败", 401);
  }
  poll(profileId: string) {
    return [...this.pending].filter(([, item]) => item.profileId === profileId && !item.delivered).map(([id, item]) => { item.delivered = true; return { id, payload: item.payload }; });
  }
  complete(profileId: string, id: string, result: unknown, error?: string) {
    const item = this.pending.get(id);
    check(item?.profileId === profileId && item.delivered, "UNKNOWN_CALL", "调用不存在");
    if (error) {
      const code = tabErrors.has(error) || ["GATEWAY_AUTH_REQUIRED", "RESPONSE_TOO_LARGE", "INVALID_RESPONSE"].includes(error) ? error : "BROWSER_REQUEST_FAILED";
      item.reject(new AppError(code, tabErrors.get(error) ?? "浏览器请求失败，请检查目标页签登录态、网关授权和接口权限"));
    } else item.resolve(result);
  }
  async call(profileId: string, payload: unknown, signal: AbortSignal) {
    check(this.sessions.has(profileId), "BROWSER_NOT_CONNECTED", "浏览器资料尚未连接");
    const id = randomUUID();
    let abort = () => {};
    try {
      return await new Promise<unknown>((resolve, reject) => {
        abort = () => reject(new AppError("CANCELLED", "浏览器调用取消或超时"));
        signal.throwIfAborted();
        this.pending.set(id, { profileId, payload, delivered: false, resolve, reject });
        signal.addEventListener("abort", abort, { once: true });
      });
    } finally { signal.removeEventListener("abort", abort); this.pending.delete(id); }
  }
  close() { for (const item of this.pending.values()) item.reject(new AppError("CANCELLED", "浏览器通道已关闭")); this.pending.clear(); this.sessions.clear(); }
}
