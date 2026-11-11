import type { FastifyInstance } from "fastify";
import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { parseStrictJson } from "./canonical.js";
import type { DictionaryService } from "./service.js";
import type { DictionaryReadiness, SecretsService } from "../secrets/service.js";
import type { LocalApiAuth } from "../web-bridge/auth.js";

const requestId = { type: "string", minLength: 1, maxLength: 200 };
function body<T>(value: unknown, properties: Record<string, unknown>, required: string[]): T {
  try { assertSchema(value, { type: "object", properties, required, additionalProperties: false }); }
  catch { throw new AppError("INVALID_REQUEST", "请求字段或类型无效", 400); }
  return value as T;
}
function cursor(value: string): number {
  check(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), "INVALID_CURSOR", "分页参数无效", 400);
  return Number(value);
}
/**
 * 敏感接口来源守卫（设计 §6.3）：Origin 必须与当前本地 HTTP authority（含端口）完全一致，
 * 拒绝跨端口来源与浏览器扩展来源；Sec-Fetch-Site 不匹配时拒绝；
 * 无 Origin 的 API 请求必须提供有效 x-orchard-token。
 */
function requireSensitiveOrigin(request: { headers: Record<string, string | string[] | undefined> }, apiAuth: LocalApiAuth): void {
  const origin = request.headers.origin;
  if (origin === undefined) {
    const suppliedToken = request.headers["x-orchard-token"];
    check(typeof suppliedToken === "string" && apiAuth.valid(suppliedToken), "UNAUTHORIZED", "本机 API 认证失败", 401);
  } else {
    const host = request.headers.host ?? "";
    let originUrl: URL;
    try { originUrl = new URL(Array.isArray(origin) ? origin[0]! : origin); } catch { throw new AppError("INVALID_ORIGIN", "请求来源与工作台不一致", 403); }
    check(originUrl.origin === origin && originUrl.protocol === "http:" && originUrl.host === host && ["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname), "INVALID_ORIGIN", "请求来源与工作台不一致", 403);
  }
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined) check(site === "same-origin", "INVALID_ORIGIN", "请求来源与工作台不一致", 403);
}

export function registerDictionaryRoutes(app: FastifyInstance, dictionaries: DictionaryService, secretsService: SecretsService, apiAuth: LocalApiAuth) {
  // 只在字典路由的封装作用域内替换 JSON 解析，保留旧接口的解析行为。
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, text, done) => {
    try { done(null, parseStrictJson(String(text), { maxDepth: 48 })); }
    catch { done(new AppError("INVALID_JSON", "请求 JSON 无效或含重复键", 400), undefined); }
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (request.url.startsWith("/api/secrets/") && request.method !== "GET") requireSensitiveOrigin(request, apiAuth);
  });
  app.addHook("preValidation", async request => {
    const allowed = request.routeOptions.url === "/api/dictionaries" && request.method === "GET"
      ? ["kind", "enabled", "readiness", "limit", "cursor", "deleted"]
      : request.routeOptions.url === "/api/dictionaries/:id/versions" ? ["limit", "cursor"]
      : request.routeOptions.url === "/api/dictionaries/:id/references" ? ["view", "limit", "cursor"] : [];
    check(Object.keys(request.query as object).every(key => allowed.includes(key)), "INVALID_REQUEST", "不支持的查询参数", 400);
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof AppError;
    const code = known ? error.code : "INTERNAL_ERROR";
    const status = known ? error.statusCode : (error as { statusCode?: number }).statusCode ?? 500;
    // 敏感接口错误不回显解析器消息、未知字段、堆栈或提交内容。
    const secret = request.url.startsWith("/api/secrets/");
    const message = secret ? (code === "INVALID_ORIGIN" ? "请求来源与工作台不一致" : code === "UNAUTHORIZED" ? "本机 API 认证失败" : "密钥操作失败，请检查格式、代次与密钥状态")
      : known ? error.message : "字典操作失败";
    const details = known && code === "CONFIRMATION_REQUIRED" ? (error as AppError & { details?: unknown }).details : undefined;
    reply.code(status).send({ code, message, ...(details ? { details } : {}) });
  });
  // ---- 字典与密钥（设计 §10.2）----
  const dictionaryKind = { type: "string", enum: ["plain", "encrypted"] };
  const operationItem = { type: "object", properties: { op: { type: "string", enum: ["set", "remove"] }, key: { type: "string" }, type: { type: "string", enum: ["string", "number", "boolean", "json"] }, value: {} }, additionalProperties: false };
  const expectedGeneration = { type: "integer", minimum: 0 };
  const operationsSchema = { type: "array", maxItems: 600, items: operationItem };
  app.get<{ Querystring: { deleted?: string; kind?: string; enabled?: string; readiness?: string; limit?: string; cursor?: string } }>("/api/dictionaries", async request => {
    const { kind, enabled, readiness, limit, cursor: page, deleted } = request.query;
    check(deleted === undefined || ["true", "false"].includes(deleted), "INVALID_REQUEST", "删除状态无效");
    check(kind === undefined || ["plain", "encrypted"].includes(kind), "INVALID_REQUEST", "字典类型无效");
    check(enabled === undefined || ["true", "false"].includes(enabled), "INVALID_REQUEST", "启用状态无效");
    check(readiness === undefined || ["ready", "missing-key", "authentication-failed", "keyring-unavailable"].includes(readiness), "INVALID_REQUEST", "就绪状态无效");
    return dictionaries.list({
      deleted: deleted === "true",
      kind: kind as "plain" | "encrypted" | undefined,
      enabled: enabled === undefined ? undefined : enabled === "true",
      readiness: readiness as DictionaryReadiness | undefined,
      limit: limit === undefined ? undefined : cursor(limit), cursor: page,
    });
  });
  app.post("/api/dictionaries", async (request, reply) => {
    const input = body<{ requestId: string; name: string; description: string; kind: string; enabled: boolean; operations: unknown }>(request.body, {
      requestId, name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 4000 }, kind: dictionaryKind, enabled: { type: "boolean" }, operations: operationsSchema,
    }, ["requestId", "name", "description", "kind", "enabled", "operations"]);
    if (input.kind === "encrypted") requireSensitiveOrigin(request, apiAuth);
    return reply.code(201).send(dictionaries.create({ ...input, kind: input.kind as "plain" | "encrypted" }));
  });
  app.get<{ Params: { id: string } }>("/api/dictionaries/:id", async request => {
    const view = dictionaries.get(request.params.id);
    check(view, "NOT_FOUND", "字典不存在", 404);
    return view;
  });
  app.delete<{ Params: { id: string } }>("/api/dictionaries/:id", async request => {
    requireSensitiveOrigin(request, apiAuth);
    const input = body<{ requestId: string; expectedRevision: number; permanent?: boolean; confirmationName?: string }>(request.body, {
      requestId, expectedRevision: { type: "integer", minimum: 1 }, permanent: { type: "boolean" },
      confirmationName: { type: "string", maxLength: 100 },
    }, ["requestId", "expectedRevision"]);
    return dictionaries.remove(request.params.id, input);
  });
  app.patch<{ Params: { id: string } }>("/api/dictionaries/:id", async (request, reply) => {
    const input = body<{ requestId: string; expectedRevision: number; name?: string; description?: string; enabled?: boolean; operations?: unknown; confirmationToken?: string }>(request.body, {
      requestId, expectedRevision: { type: "integer", minimum: 1 }, name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 4000 },
      enabled: { type: "boolean" }, operations: operationsSchema, confirmationToken: { type: "string", minLength: 8, maxLength: 100 },
    }, ["requestId", "expectedRevision", "operations"]);
    if (dictionaries.get(request.params.id)?.kind === "encrypted") requireSensitiveOrigin(request, apiAuth);
    return reply.code(200).send(dictionaries.update(request.params.id, { ...input, operations: input.operations }));
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/api/dictionaries/:id/versions", async request => {
    const { limit, cursor: page } = request.query;
    return dictionaries.versions(request.params.id, { limit: limit === undefined ? undefined : cursor(limit), cursor: page });
  });
  app.get<{ Params: { id: string; versionId: string } }>("/api/dictionaries/:id/versions/:versionId", async request => {
    const detail = dictionaries.version(request.params.id, request.params.versionId);
    check(detail, "NOT_FOUND", "修订不存在", 404);
    return detail;
  });
  app.get<{ Params: { id: string }; Querystring: { view?: "current" | "history" | "all"; limit?: string; cursor?: string } }>("/api/dictionaries/:id/references", async request => {
    const { view, limit, cursor: page } = request.query;
    return dictionaries.referenceList(request.params.id, { view, limit: limit === undefined ? undefined : cursor(limit), cursor: page });
  });
  app.post<{ Params: { id: string } }>("/api/dictionaries/:id/re-encryption-preview", async request => {
    const input = body<{ expectedRevision: number }>(request.body, { expectedRevision: { type: "integer", minimum: 1 } }, ["expectedRevision"]);
    requireSensitiveOrigin(request, apiAuth);
    return dictionaries.reEncryptionPreview(request.params.id, input);
  });
  app.post<{ Params: { id: string } }>("/api/dictionaries/:id/re-encrypt", async request => {
    const input = body<{ requestId: string; token: string; expectedRevision: number }>(request.body, {
      requestId, token: { type: "string", minLength: 8, maxLength: 100 }, expectedRevision: { type: "integer", minimum: 1 },
    }, ["requestId", "token", "expectedRevision"]);
    requireSensitiveOrigin(request, apiAuth);
    return dictionaries.reEncrypt(request.params.id, input);
  });
  app.get("/api/secrets/status", async () => secretsService.status());
  app.post("/api/secrets/keys", async (request, reply) => {
    const input = body<{ requestId: string; expectedGeneration: number; makeActive?: boolean }>(request.body, {
      requestId, expectedGeneration, makeActive: { type: "boolean" },
    }, ["requestId", "expectedGeneration"]);
    requireSensitiveOrigin(request, apiAuth);
    return reply.code(201).send(secretsService.generate(input));
  });
  app.post("/api/secrets/import", async (request, reply) => {
    const input = body<{ requestId: string; expectedGeneration: number; backupText: string; activeKeyId?: string }>(request.body, {
      requestId, expectedGeneration, backupText: { type: "string", minLength: 1, maxLength: 1024 * 1024 }, activeKeyId: { type: "string", minLength: 1, maxLength: 128 },
    }, ["requestId", "expectedGeneration", "backupText"]);
    requireSensitiveOrigin(request, apiAuth);
    return reply.code(201).send(secretsService.import(input));
  });
  app.post("/api/secrets/export", async (request, reply) => {
    const input = body<{ expectedGeneration: number; keyIds?: string[] }>(request.body, {
      expectedGeneration, keyIds: { type: "array", maxItems: 256, items: { type: "string", minLength: 1, maxLength: 128 } },
    }, ["expectedGeneration"]);
    requireSensitiveOrigin(request, apiAuth);
    const backup = secretsService.exportBackup(input);
    // 专用备份下载：no-store + attachment，正文不经 DTO 或事件流，服务端不保留副本。
    reply.header("Cache-Control", "no-store").header("Content-Disposition", `attachment; filename="${backup.filename}"`).type("application/json");
    return reply.code(200).send(backup.body);
  });
  app.post("/api/secrets/verify", async request => {
    const input = body<{ expectedGeneration: number; dictionaryIds?: string[] }>(request.body, {
      expectedGeneration, dictionaryIds: { type: "array", maxItems: 500, items: { type: "string", minLength: 1 } },
    }, ["expectedGeneration"]);
    requireSensitiveOrigin(request, apiAuth);
    return secretsService.verify(input);
  });
  app.put("/api/secrets/active-key", async request => {
    const input = body<{ requestId: string; expectedGeneration: number; keyId: string }>(request.body, {
      requestId, expectedGeneration, keyId: { type: "string", minLength: 1, maxLength: 128 },
    }, ["requestId", "expectedGeneration", "keyId"]);
    requireSensitiveOrigin(request, apiAuth);
    return secretsService.activate(input);
  });
}
