import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import type { WorkflowRecord } from "../storage/repository.js";
import { WORKBENCH_HTML, WORKBENCH_JS } from "./workbench.js";

export interface ServerOptions {
  readonly accessToken?: string;
  readonly authority?: string;
  readonly listWorkflows?: (limit: number, offset: number) => readonly WorkflowRecord[];
  readonly listRuns?: (limit: number, offset: number) => readonly { id: string; workflowVersionId: string; status: string; inputRef?: string; createdAt?: number }[];
  readonly getRun?: (id: string) => { id: string; workflowVersionId: string; status: string; inputRef?: string; createdAt?: number } | undefined;
  readonly cancelRun?: (id: string, reason: string) => boolean;
  readonly receiveEvent?: (input: { source: string; eventId: string; name: string; data: unknown }) => { id: string; duplicate: boolean };
}

export function createServer(options: ServerOptions = {}): FastifyInstance {
  if (options.listWorkflows && (!options.accessToken || options.accessToken.length < 32)) {
    throw new Error("Workflow access requires an access token of at least 32 characters");
  }
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const authority = options.authority ?? "localhost:80";
  const expectedToken = createHash("sha256").update(options.accessToken ?? "").digest();

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const fail = (code: string, message: string, status: number) => reply.code(status).send({ code, message, requestId: request.id });
    // Exact authority matching also blocks DNS rebinding. No forwarded headers are trusted.
    const host = request.headers.host;
    const expectedHost = authority.endsWith(":80") ? authority.slice(0, -3) : authority;
    if (host !== authority && host !== expectedHost) return fail("INVALID_HOST", "Host is not allowed", 403);
    if (request.headers.origin) {
      let origin: URL;
      try { origin = new URL(request.headers.origin); } catch { return fail("INVALID_ORIGIN", "Origin is not allowed", 403); }
      if (origin.origin !== `http://${expectedHost}` || request.headers.origin !== origin.origin) {
        return fail("INVALID_ORIGIN", "Origin is not allowed", 403);
      }
    }
    const pathname = request.url.split("?")[0];
    if (pathname === "/" || pathname === "/workbench.js" || pathname === "/api/health") return;
    const authorization = request.headers.authorization;
    if (!options.accessToken || !authorization?.startsWith("Bearer ")) return fail("UNAUTHORIZED", "Access token required", 401);
    const supplied = createHash("sha256").update(authorization.slice(7)).digest();
    if (!timingSafeEqual(expectedToken, supplied)) return fail("UNAUTHORIZED", "Invalid access token", 401);
  });

  app.setErrorHandler((error, request, reply) => {
    const invalid = typeof error === "object" && error !== null && "validation" in error;
    reply.code(invalid ? 400 : 500).send({
      code: invalid ? "INVALID_REQUEST" : "INTERNAL_ERROR",
      message: invalid ? "Invalid request parameters" : "Internal server error",
      requestId: request.id,
    });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: "NOT_FOUND", message: "Route not found", requestId: request.id }));

  app.get("/api/health", async () => ({ status: "ok", service: "orchard", version: "0.1.0" }));
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(WORKBENCH_HTML));
  app.get("/workbench.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(WORKBENCH_JS));
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    if (!options.getRun) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const run = options.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ code: "RUN_NOT_FOUND", message: "Run not found", requestId: request.id });
    return run;
  });

  app.post<{ Params: { runId: string }; Body: { reason?: string } }>("/api/runs/:runId/cancel", {
    schema: { body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    if (!options.cancelRun) return reply.code(503).send({ code: "RUNTIME_UNAVAILABLE", message: "Run control is not connected", requestId: request.id });
    const cancelled = options.cancelRun(request.params.runId, request.body?.reason ?? "User requested cancellation");
    if (!cancelled) return reply.code(409).send({ code: "RUN_NOT_CANCELLABLE", message: "Run is not cancellable or does not exist", requestId: request.id });
    return { accepted: true, runId: request.params.runId };
  });

  app.get<{ Querystring: { limit?: number; offset?: number } }>("/api/runs", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
    } } },
  }, async (request, reply) => {
    if (!options.listRuns) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const limit = request.query.limit ?? 50;
    const offset = request.query.offset ?? 0;
    const items = options.listRuns(limit, offset).map(({ id, workflowVersionId, status, inputRef, createdAt }) => ({ id, workflowVersionId, status, ...(inputRef === undefined ? {} : { inputRef }), ...(createdAt === undefined ? {} : { createdAt }) }));
    return { items, limit, offset };
  });

  app.post<{ Body: { source: string; id: string; name: string; data: unknown } }>("/api/events", {
    schema: { body: { type: "object", additionalProperties: false, required: ["source", "id", "name", "data"], properties: {
      source: { type: "string", minLength: 1, maxLength: 200 }, id: { type: "string", minLength: 1, maxLength: 500 }, name: { type: "string", minLength: 1, maxLength: 200 }, data: {},
    } } },
  }, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "source") || !Object.hasOwn(body, "id") || !Object.hasOwn(body, "name") || !Object.hasOwn(body, "data") || Object.keys(body).some((key) => !["source", "id", "name", "data"].includes(key)) || typeof body.source !== "string" || typeof body.id !== "string" || typeof body.name !== "string" || body.source.length < 1 || body.source.length > 200 || body.id.length < 1 || body.id.length > 500 || body.name.length < 1 || body.name.length > 200) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "Invalid event body", requestId: request.id });
    }
    if (!options.receiveEvent) return reply.code(503).send({ code: "EVENTS_UNAVAILABLE", message: "Event intake is not connected", requestId: request.id });
    const result = options.receiveEvent({ source: body.source, eventId: body.id, name: body.name, data: body.data });
    return reply.code(result.duplicate ? 200 : 202).send({ eventId: result.id, duplicate: result.duplicate });
  });

  app.get<{ Querystring: { limit?: number; offset?: number } }>("/api/workflows", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
    } } },
  }, async (request, reply) => {
    if (!options.listWorkflows) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const limit = request.query.limit ?? 50;
    const offset = request.query.offset ?? 0;
    const items = options.listWorkflows(limit, offset).map(({ id, workspaceId, name, description, status }) => ({ id, workspaceId, name, description, status }));
    return { items, limit, offset };
  });
  return app;
}
