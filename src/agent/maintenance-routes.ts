import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertSchema } from "../domain/validation.js";
import { check } from "../domain/errors.js";
import type { MaintenanceService } from "./maintenance-service.js";
import type { MaintenanceTarget } from "./maintenance-protocol.js";
import type { MaintenanceTaskApi } from "./maintenance-composition.js";

const id = { type: "string", minLength: 1, maxLength: 200 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const body = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const taskInput = {
  type: "object", required: ["requestId", "prompt"], additionalProperties: false,
  properties: { requestId: id, prompt: { type: "string", minLength: 1, maxLength: 100000 }, sessionId: id, providerId: id, modelId: id },
};
const ownerParams = body({ kind: { enum: ["workflow_draft", "script_draft", "browser_application"] }, id });

/** Installed by the new runtime composition root only after migration/capability
 * gates. Page authority is supplied by the trusted HTTP boundary, never a body
 * actor/confirmed flag or an Agent MCP grant. No models are launched here. */
export function registerMaintenanceRoutes(app: FastifyInstance, options: {
  service: MaintenanceService;
  tasks?(): MaintenanceTaskApi | undefined;
  authorizeUserRequest(request: FastifyRequest): string;
  /** Schedule a platform-owned worker, NOT another model request. */
  schedule(actor: string, applicationId: string): void;
}) {
  const actor = (request: FastifyRequest) => {
    const actor = options.authorizeUserRequest(request);
    check(typeof actor === "string" && actor.trim().length > 0, "UNAUTHORIZED", "需要页面用户身份", 403); return actor;
  };
  app.get<{ Params: { id: string } }>("/api/maintenance/sessions/:id/proposals", async request => ({ items: options.service.list(actor(request), request.params.id) }));
  app.get<{ Params: { kind: MaintenanceTarget["kind"]; id: string } }>("/api/maintenance/owners/:kind/:id/proposals", async request => {
    const user = actor(request);
    const { kind, id: owner } = request.params;
    assertSchema(request.params, ownerParams, "维护对象");
    return { items: options.service.listForOwner(user, kind, owner) };
  });
  app.get<{ Params: { kind: MaintenanceTarget["kind"]; id: string }; Querystring: { sessionId?: string } }>("/api/maintenance/owners/:kind/:id/chat", async request => {
    const user = actor(request), tasks = options.tasks?.();
    check(tasks, "BACKEND_UNAVAILABLE", "维护任务服务不可用", 503);
    assertSchema(request.params, ownerParams, "维护对象");
    assertSchema(request.query, { type: "object", properties: { sessionId: id }, additionalProperties: false }, "维护会话查询");
    return tasks.history(user, request.params.kind, request.params.id, request.query.sessionId);
  });
  app.post<{ Params: { id: string; taskId: string } }>("/api/maintenance/sessions/:id/tasks/:taskId/cancel", async request => {
    const user = actor(request), tasks = options.tasks?.();
    check(tasks, "BACKEND_UNAVAILABLE", "维护任务服务不可用", 503);
    return tasks.cancel(user, request.params.id, request.params.taskId);
  });
  app.post<{ Params: { kind: MaintenanceTarget["kind"]; id: string } }>("/api/maintenance/owners/:kind/:id/tasks", { bodyLimit: 270336 }, async (request, reply) => {
    const user = actor(request), tasks = options.tasks?.();
    check(tasks, "BACKEND_UNAVAILABLE", "维护任务服务不可用", 503);
    assertSchema(request.params, ownerParams, "维护对象");
    assertSchema(request.body, taskInput, "维护任务");
    reply.code(202);
    return tasks.start(user, request.params.kind, request.params.id, request.body as { requestId: string; prompt: string; sessionId?: string; providerId?: string; modelId?: string });
  });
  app.get<{ Params: { id: string } }>("/api/maintenance/sessions/:id/tasks", async request => {
    const user = actor(request), tasks = options.tasks?.();
    check(tasks, "BACKEND_UNAVAILABLE", "维护任务服务不可用", 503);
    return { items: tasks.list(user, request.params.id) };
  });
  app.get<{ Params: { id: string } }>("/api/maintenance/proposals/:id", async request => options.service.view(actor(request), request.params.id));
  app.post<{ Params: { id: string } }>("/api/maintenance/proposals/:id/decision", { bodyLimit: 65536 }, async request => {
    const user = actor(request);
    assertSchema(request.body, body({ action: { enum: ["confirm", "revoke"] }, contentHash: hash, diffHash: hash, requestId: id }), "用户提案决定");
    const value = request.body as { action: "confirm" | "revoke"; contentHash: string; diffHash: string; requestId: string };
    return options.service.decideByUser(user, request.params.id, value.action, value.contentHash, value.diffHash, value.requestId);
  });
  app.post<{ Params: { id: string } }>("/api/maintenance/proposals/:id/apply", { bodyLimit: 65536 }, async (request, reply) => {
    const user = actor(request); assertSchema(request.body, body({ requestId: id }), "应用提案");
    const receipt = options.service.enqueue(user, request.params.id, (request.body as { requestId: string }).requestId);
    if (receipt.status === "queued") { options.schedule(user, receipt.id); reply.code(202); }
    return receipt;
  });
  app.get<{ Params: { id: string } }>("/api/maintenance/applications/:id", async request => options.service.receipt(actor(request), request.params.id));
  app.get("/api/maintenance/retention", async request => options.service.previewRetention(actor(request)));
  app.post("/api/maintenance/retention", { bodyLimit: 4096 }, async request => {
    const user = actor(request);
    assertSchema(request.body, body({ hash }), "维护保留清理");
    return options.service.applyRetention(user, (request.body as { hash: string }).hash);
  });
}
