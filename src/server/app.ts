import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentProfileRecord, WorkflowRecord } from "../storage/repository.js";
import { agentProfileValidationError } from "../integrations/pi/profile.js";
import { WORKBENCH_HTML } from "./workbench.js";
import type { WorkflowDetail } from "./workflow-detail.js";

export interface ServerOptions {
  readonly authority?: string;
  readonly listWorkflows?: (limit: number, offset: number) => readonly WorkflowRecord[];
  readonly deleteWorkflow?: (id: string) => boolean;
  readonly getWorkflowDetail?: (id: string) => Promise<WorkflowDetail | undefined>;
  readonly listRuns?: (limit: number, offset: number, filter?: { workflowId?: string; workflowVersionId?: string; status?: string; triggerId?: string; since?: number; until?: number }) => readonly { id: string; workflowVersionId: string; status: string; inputRef?: string; createdAt?: number }[];
  readonly getRun?: (id: string) => { id: string; workflowVersionId: string; status: string; inputRef?: string; createdAt?: number } | undefined;
  readonly listRunEvents?: (id: string) => readonly { id: string; sequenceNo: number; type: string; stepId?: string; attemptId?: string; payload?: unknown; createdAt: number }[];
  readonly traceRun?: (id: string) => readonly unknown[];
  readonly rerunRun?: (id: string, stepId?: string) => { id: string; workflowVersionId: string; status: string };
  readonly createWorkflow?: (input: { name: string; description?: string }) => WorkflowRecord | Promise<WorkflowRecord>;
  readonly listDiscoveredWorkflows?: () => Promise<readonly unknown[]> | readonly unknown[];
  readonly addDiscoveredWorkflow?: (input: { workspace: string; id: string }) => Promise<unknown> | unknown;
  readonly listAgents?: () => readonly AgentProfileRecord[];
  readonly createAgent?: (input: { name: string; provider: string; model: string; config?: unknown; allowedTools?: readonly string[] }) => AgentProfileRecord;
  /** CLI backend status/edit surface (GET runs an immediate L1 probe; deep adds L2). */
  readonly cliBackendStatus?: (deep: boolean) => Promise<readonly unknown[]> | readonly unknown[];
  /** Saves (probed first) or clears (null/empty path) a launcher's trusted path. Throws to reject. */
  readonly setCliBackendPath?: (launcher: "pi-cli" | "codex-cli", path: string | null) => Promise<unknown> | unknown;
  readonly createDraft?: (input: { workflowId?: string; baseVersionId?: string }) => unknown;
  readonly getDraft?: (draftId: string) => unknown;
  readonly updateDraft?: (draftId: string, input: { revision: number; files: Record<string, string> }) => boolean;
  readonly authorPi?: (input: { draftId: string; prompt: string }) => Promise<unknown>;
  readonly importWorkflow?: (body: unknown) => Promise<unknown>;
  readonly exportWorkflow?: (workflowId: string) => Promise<unknown>;
  readonly listTasks?: (runId?: string) => readonly unknown[];
  readonly getTask?: (taskId: string) => unknown;
  readonly listContinuations?: (runId?: string) => readonly unknown[];
  readonly listSchedulingDecisions?: (runId?: string) => readonly unknown[];
  readonly workerHealth?: () => unknown;
  readonly publishWorkflow?: (workflowId: string, entry: string) => Promise<{ workflowId: string; versionId: string; contentHash: string; bundlePath: string }>;
  readonly listWorkflowVersions?: (workflowId: string) => readonly unknown[];
  readonly listSchedules?: () => readonly unknown[];
  readonly createSchedule?: (input: { workflowId: string; workflowVersionId?: string; expression: string; timezone?: string; misfirePolicy?: string }) => unknown;
  readonly setScheduleEnabled?: (scheduleId: string, enabled: boolean) => boolean;
  readonly createRun?: (workflowId: string, input: unknown, idempotencyKey?: string) => { id: string; workflowVersionId: string; status: string; inputRef?: string };
  readonly cancelRun?: (id: string, reason: string) => boolean;
  readonly receiveEvent?: (input: { source: string; eventId: string; name: string; data: unknown }) => { id: string; duplicate: boolean; deliveries?: readonly string[] };
}

export function createServer(options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const authority = options.authority ?? "localhost:80";

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Operation-Id", request.id);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
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
    // Also reject browser cross-site requests that omit Origin (for example image GETs).
    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return fail("CROSS_SITE_REQUEST", "Cross-site requests are not allowed", 403);
    }
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
  app.get("/api/worker/health", async (_request, reply) => {
    if (!options.workerHealth) return reply.code(503).send({ code: "WORKER_UNAVAILABLE", message: "Worker health is not connected" });
    return options.workerHealth();
  });
  const serveWorkbench = async (_request: unknown, reply: { type: (contentType: string) => { send: (body: string) => unknown } }) => reply.type("text/html; charset=utf-8").send(WORKBENCH_HTML);
  app.get("/", serveWorkbench);
  app.get("/workflows", serveWorkbench);
  app.get("/workflows/:workflowId", serveWorkbench);
  app.get("/runs", serveWorkbench);
  app.get("/runs/:runId", serveWorkbench);
  app.get("/settings", serveWorkbench);
  app.get("/workbench.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await readFile(new URL("./workbench.css", import.meta.url), "utf8")));
  app.get("/workbench.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(await readFile(new URL("./client.js", import.meta.url), "utf8")));
  app.get("/editor.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await readFile(new URL("./client.css", import.meta.url), "utf8")));
  app.get("/editor-assets/editor.worker.js", async (_request, reply) => reply.type("application/javascript; charset=utf-8").send(await readFile(new URL("./editor-assets/editor.worker.js", import.meta.url), "utf8")));
  app.get("/api/agents", async (_request, reply) => {
    if (!options.listAgents) return reply.code(503).send({ code: "AGENTS_UNAVAILABLE", message: "Agent storage is not connected" });
    // Legacy rows with free-text providers stay visible but annotated; secret_ref is deprecated and never returned.
    const items = options.listAgents().map(({ secretRef: _secretRef, ...agent }) => {
      const validationError = agentProfileValidationError(agent);
      return { ...agent, ...(validationError ? { validationError } : {}) };
    });
    return { items };
  });
  app.post<{ Body: { name: string; provider: string; model: string; config?: unknown; allowedTools?: string[] } }>("/api/agents", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "provider", "model"], properties: { name: { type: "string", minLength: 1, maxLength: 200 }, provider: { type: "string", enum: ["pi-cli", "codex-cli"] }, model: { type: "string", maxLength: 200 }, config: {}, allowedTools: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 50 } } } },
  }, async (request, reply) => {
    if (!options.createAgent) return reply.code(503).send({ code: "AGENTS_UNAVAILABLE", message: "Agent storage is not connected" });
    try { return reply.code(201).send(options.createAgent(request.body)); }
    catch (error) { return reply.code(400).send({ code: "INVALID_AGENT_PROFILE", message: error instanceof Error ? error.message : "Agent profile validation failed", requestId: request.id }); }
  });
  app.get<{ Querystring: { readiness?: string } }>("/api/settings/cli-backends", async (request, reply) => {
    if (!options.cliBackendStatus) return reply.code(503).send({ code: "SETTINGS_UNAVAILABLE", message: "CLI backend settings are not connected", requestId: request.id });
    return { items: await options.cliBackendStatus(request.query?.readiness === "deep") };
  });
  app.put<{ Params: { launcher: string }; Body: { path: string | null } }>("/api/settings/cli-backends/:launcher", {
    schema: {
      params: { type: "object", required: ["launcher"], properties: { launcher: { type: "string", enum: ["pi-cli", "codex-cli"] } } },
      body: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: ["string", "null"], maxLength: 500 } } },
    },
  }, async (request, reply) => {
    if (!options.setCliBackendPath) return reply.code(503).send({ code: "SETTINGS_UNAVAILABLE", message: "CLI backend settings are not connected", requestId: request.id });
    const path = request.body.path === "" ? null : request.body.path;
    try { return await options.setCliBackendPath(request.params.launcher as "pi-cli" | "codex-cli", path); }
    catch (error) { return reply.code(400).send({ code: "CLI_BACKEND_PATH_REJECTED", message: error instanceof Error ? error.message : "The path was rejected", requestId: request.id }); }
  });
  app.get("/api/workflows/discovered", async (_request, reply) => {
    if (!options.listDiscoveredWorkflows) return reply.code(503).send({ code: "DISCOVERY_UNAVAILABLE", message: "Workflow discovery is not connected" });
    return { items: await options.listDiscoveredWorkflows() };
  });
  app.get<{ Params: { workflowId: string } }>("/api/workflows/:workflowId", async (request, reply) => {
    if (!options.getWorkflowDetail) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Workflow storage is not connected", requestId: request.id });
    const detail = await options.getWorkflowDetail(request.params.workflowId);
    if (!detail) return reply.code(404).send({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在", requestId: request.id });
    return detail;
  });
  app.delete<{ Params: { workflowId: string } }>("/api/workflows/:workflowId", async (request, reply) => {
    if (!options.deleteWorkflow) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Workflow storage is not connected" });
    try {
      if (!options.deleteWorkflow(request.params.workflowId)) return reply.code(404).send({ code: "WORKFLOW_NOT_FOUND", message: "工作流不存在" });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Error && error.name === "WORKFLOW_BUSY") return reply.code(409).send({ code: "WORKFLOW_BUSY", message: error.message });
      throw error;
    }
  });
  app.post<{ Body: { workspace: string; id: string } }>("/api/workflows/discovered", {
    schema: { body: { type: "object", additionalProperties: false, required: ["workspace", "id"], properties: { workspace: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }, id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" } } } },
  }, async (request, reply) => {
    if (!options.addDiscoveredWorkflow) return reply.code(503).send({ code: "DISCOVERY_UNAVAILABLE", message: "Workflow discovery is not connected" });
    try { return reply.code(201).send(await options.addDiscoveredWorkflow(request.body)); }
    catch (error) { return reply.code(400).send({ code: "WORKFLOW_ADD_FAILED", message: error instanceof Error ? error.message : "Unable to add workflow", requestId: request.id }); }
  });
  app.post<{ Body: { name: string; description?: string } }>("/api/workflows", {
    schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", maxLength: 2_000 } } } },
  }, async (request, reply) => {
    if (!options.createWorkflow) return reply.code(503).send({ code: "AUTHORING_UNAVAILABLE", message: "Workflow authoring is not connected", requestId: request.id });
    return reply.code(201).send(await options.createWorkflow(request.body));
  });
  app.post<{ Params: { workflowId: string }; Body: { baseVersionId?: string } }>("/api/workflows/:workflowId/drafts", {
    schema: { body: { type: "object", additionalProperties: false, properties: { baseVersionId: { type: "string", minLength: 1 } } } },
  }, async (request, reply) => {
    if (!options.createDraft) return reply.code(503).send({ code: "AUTHORING_UNAVAILABLE", message: "Draft authoring is not connected", requestId: request.id });
    return reply.code(201).send(options.createDraft({ workflowId: request.params.workflowId, ...(request.body?.baseVersionId ? { baseVersionId: request.body.baseVersionId } : {}) }));
  });
  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId", async (request, reply) => {
    if (!options.getDraft) return reply.code(503).send({ code: "AUTHORING_UNAVAILABLE", message: "Draft storage is not connected", requestId: request.id });
    const draft = options.getDraft(request.params.draftId);
    if (!draft) return reply.code(404).send({ code: "DRAFT_NOT_FOUND", message: "Draft not found", requestId: request.id });
    return draft;
  });
  app.patch<{ Params: { draftId: string }; Body: { revision: number; files: Record<string, string> } }>("/api/drafts/:draftId", {
    schema: { body: { type: "object", additionalProperties: false, required: ["revision", "files"], properties: { revision: { type: "integer", minimum: 0 }, files: { type: "object", additionalProperties: { type: "string" } } } } },
  }, async (request, reply) => {
    if (!options.updateDraft) return reply.code(503).send({ code: "AUTHORING_UNAVAILABLE", message: "Draft storage is not connected", requestId: request.id });
    if (!options.updateDraft(request.params.draftId, request.body)) return reply.code(409).send({ code: "DRAFT_REVISION_CONFLICT", message: "Draft revision is stale", requestId: request.id });
    return { draftId: request.params.draftId, revision: request.body.revision + 1 };
  });
  app.post<{ Params: { draftId: string }; Body: { prompt: string } }>("/api/drafts/:draftId/author", {
    schema: { body: { type: "object", additionalProperties: false, required: ["prompt"], properties: { prompt: { type: "string", minLength: 1, maxLength: 20_000 } } } },
  }, async (request, reply) => {
    if (!options.authorPi) return reply.code(503).send({ code: "PI_UNAVAILABLE", message: "Pi authoring is not configured", requestId: request.id });
    try { return reply.code(202).send(await options.authorPi({ draftId: request.params.draftId, prompt: request.body.prompt })); } catch (error) { return reply.code(400).send({ code: "PI_AUTHORING_FAILED", message: error instanceof Error ? error.message : "Pi authoring failed", requestId: request.id }); }
  });
  app.post<{ Body: unknown }>("/api/workflows/import", async (request, reply) => {
    if (!options.importWorkflow) return reply.code(503).send({ code: "IMPORT_UNAVAILABLE", message: "Workflow import is not connected", requestId: request.id });
    try { return reply.code(201).send(await options.importWorkflow(request.body)); } catch (error) { return reply.code(400).send({ code: "IMPORT_FAILED", message: error instanceof Error ? error.message : "Workflow import failed", requestId: request.id }); }
  });
  app.get<{ Params: { workflowId: string } }>("/api/workflows/:workflowId/export", async (request, reply) => {
    if (!options.exportWorkflow) return reply.code(503).send({ code: "EXPORT_UNAVAILABLE", message: "Workflow export is not connected", requestId: request.id });
    try { return reply.send(await options.exportWorkflow(request.params.workflowId)); } catch (error) { return reply.code(400).send({ code: "EXPORT_FAILED", message: error instanceof Error ? error.message : "Workflow export failed", requestId: request.id }); }
  });
  app.get<{ Params: { workflowId: string } }>("/api/workflows/:workflowId/versions", async (request, reply) => {
    if (!options.listWorkflowVersions) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Version storage is not connected", requestId: request.id });
    return { workflowId: request.params.workflowId, items: options.listWorkflowVersions(request.params.workflowId) };
  });
  app.post<{ Params: { workflowId: string }; Body: { entry: string } }>("/api/workflows/:workflowId/publish", {
    schema: { body: { type: "object", additionalProperties: false, required: ["entry"], properties: { entry: { type: "string", minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    if (!options.publishWorkflow) return reply.code(503).send({ code: "AUTHORING_UNAVAILABLE", message: "Workflow publishing is not connected", requestId: request.id });
    try { return reply.code(201).send(await options.publishWorkflow(request.params.workflowId, request.body.entry)); }
    catch (error) { const message = error instanceof Error ? error.message : "Unable to publish workflow"; return reply.code(400).send({ code: "PUBLISH_FAILED", message, requestId: request.id }); }
  });
  app.post<{ Params: { workflowId: string }; Headers: { "idempotency-key"?: string }; Body: { input?: unknown } }>("/api/workflows/:workflowId/runs", {
    schema: { body: { type: "object", additionalProperties: false, properties: { input: {} } } },
  }, async (request, reply) => {
    if (!options.createRun) return reply.code(503).send({ code: "RUNTIME_UNAVAILABLE", message: "Run creation is not connected", requestId: request.id });
    try {
      const result = options.createRun(request.params.workflowId, request.body?.input, request.headers["idempotency-key"]);
      return reply.code(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create run";
      if (message === "WORKFLOW_NOT_FOUND") return reply.code(404).send({ code: "WORKFLOW_NOT_FOUND", message: "Workflow has no published version", requestId: request.id });
      if (message === "IDEMPOTENCY_CONFLICT") return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT", message: "Idempotency key was used with a different request", requestId: request.id });
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => {
    if (!options.getRun) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const run = options.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ code: "RUN_NOT_FOUND", message: "Run not found", requestId: request.id });
    return run;
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/trace", async (request, reply) => {
    if (!options.traceRun) return reply.code(503).send({ code: "TRACE_UNAVAILABLE", message: "Run trace is not connected", requestId: request.id });
    return { runId: request.params.runId, items: options.traceRun(request.params.runId) };
  });

  app.post<{ Params: { runId: string }; Body: { stepId?: string } }>("/api/runs/:runId/rerun", {
    schema: { body: { type: "object", additionalProperties: false, properties: { stepId: { type: "string", minLength: 1, maxLength: 200 } } } },
  }, async (request, reply) => {
    if (!options.rerunRun) return reply.code(503).send({ code: "RUNTIME_UNAVAILABLE", message: "Run replay is not connected", requestId: request.id });
    try { return reply.code(202).send(options.rerunRun(request.params.runId, request.body?.stepId)); } catch (error) { return reply.code(400).send({ code: "RERUN_FAILED", message: error instanceof Error ? error.message : "Unable to rerun run", requestId: request.id }); }
  });

  app.get<{ Params: { runId: string } }>("/api/runs/:runId/events", async (request, reply) => {
    if (!options.listRunEvents) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Run history is not connected", requestId: request.id });
    return { runId: request.params.runId, items: options.listRunEvents(request.params.runId) };
  });

  app.post<{ Params: { runId: string }; Body: { reason?: string } }>("/api/runs/:runId/cancel", {
    schema: { body: { type: "object", additionalProperties: false, properties: { reason: { type: "string", minLength: 1, maxLength: 500 } } } },
  }, async (request, reply) => {
    if (!options.cancelRun) return reply.code(503).send({ code: "RUNTIME_UNAVAILABLE", message: "Run control is not connected", requestId: request.id });
    const cancelled = options.cancelRun(request.params.runId, request.body?.reason ?? "User requested cancellation");
    if (!cancelled) return reply.code(409).send({ code: "RUN_NOT_CANCELLABLE", message: "Run is not cancellable or does not exist", requestId: request.id });
    return { accepted: true, runId: request.params.runId };
  });

  app.get<{ Querystring: { limit?: number; offset?: number; workflowId?: string; workflowVersionId?: string; status?: string; triggerId?: string; since?: number; until?: number } }>("/api/runs", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 1_000_000 }, workflowId: { type: "string", minLength: 1 }, workflowVersionId: { type: "string", minLength: 1 }, status: { type: "string", minLength: 1 }, triggerId: { type: "string", minLength: 1 }, since: { type: "integer", minimum: 0 }, until: { type: "integer", minimum: 0 },
    } } },
  }, async (request, reply) => {
    if (!options.listRuns) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const limit = request.query.limit ?? 50;
    const offset = request.query.offset ?? 0;
    const items = options.listRuns(limit, offset, request.query).map(({ id, workflowVersionId, status, inputRef, createdAt }) => ({ id, workflowVersionId, status, ...(inputRef === undefined ? {} : { inputRef }), ...(createdAt === undefined ? {} : { createdAt }) }));
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
    try {
      const result = options.receiveEvent({ source: body.source, eventId: body.id, name: body.name, data: body.data });
      return reply.code(result.duplicate ? 200 : 202).send({ eventId: result.id, duplicate: result.duplicate, ...(result.deliveries === undefined ? {} : { deliveries: result.deliveries }) });
    } catch (error) {
      if (error instanceof Error && error.name === "EVENT_CONFLICT") return reply.code(409).send({ code: "EVENT_CONFLICT", message: error.message, requestId: request.id });
      throw error;
    }
  });

  app.get("/api/schedules", async (_request, reply) => {
    if (!options.listSchedules) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Schedule storage is not connected" });
    return { items: options.listSchedules() };
  });
  const definitionReadOnly = (_request: unknown, reply: import("fastify").FastifyReply) => reply.code(409).send({ code: "SOURCE_DEFINITION_READ_ONLY", message: "触发器和执行策略只允许在工作流源码中修改并发布。" });
  app.post("/api/schedules", definitionReadOnly);
  app.post("/api/schedules/:scheduleId/enabled", definitionReadOnly);
  app.patch("/api/schedules/:scheduleId", definitionReadOnly);
  app.delete("/api/schedules/:scheduleId", definitionReadOnly);
  app.patch("/api/workflows/:workflowId", definitionReadOnly);
  app.get<{ Querystring: { runId?: string } }>("/api/tasks", async (request, reply) => {
    if (!options.listTasks) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Task storage is not connected", requestId: request.id });
    return { items: options.listTasks(request.query.runId) };
  });
  app.get<{ Querystring: { runId?: string } }>("/api/continuations", async (request, reply) => {
    if (!options.listContinuations) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Continuation storage is not connected", requestId: request.id });
    return { items: options.listContinuations(request.query.runId) };
  });
  app.get<{ Querystring: { runId?: string } }>("/api/scheduling-decisions", async (request, reply) => {
    if (!options.listSchedulingDecisions) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Scheduling history is not connected", requestId: request.id });
    return { items: options.listSchedulingDecisions(request.query.runId) };
  });
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId", async (request, reply) => {
    if (!options.getTask) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Task storage is not connected", requestId: request.id });
    const task = options.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ code: "TASK_NOT_FOUND", message: "Task not found", requestId: request.id });
    return task;
  });
  app.get<{ Querystring: { limit?: number; offset?: number } }>("/api/workflows", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
    } } },
  }, async (request, reply) => {
    if (!options.listWorkflows) return reply.code(503).send({ code: "STORAGE_UNAVAILABLE", message: "Storage is not connected", requestId: request.id });
    const limit = request.query.limit ?? 50;
    const offset = request.query.offset ?? 0;
    const items = await Promise.all(options.listWorkflows(limit, offset).map(async ({ id, workspaceId, name, status }) => {
      const detail = await options.getWorkflowDetail?.(id);
      return { id, workspaceId, name: detail?.workflow.name ?? id, description: detail?.workflow.description, status };
    }));
    return { items, limit, offset };
  });
  return app;
}
