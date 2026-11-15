import type { FastifyInstance } from "fastify";
import { assertSchema } from "../domain/validation.js";
import type { CardInput, QuickLaunchService } from "./service.js";

const requestId = { type: "string", minLength: 1, maxLength: 200 };
const revision = { type: "integer", minimum: 1 };
const card = {
  requestId, name: { type: "string", maxLength: 200 }, note: { type: "string", maxLength: 1000 },
  groupId: { type: ["string", "null"] }, target: {}, fixedInput: {}, inputSources: { type: "object", maxProperties: 256 }
};
function parse<T>(input: unknown, properties: Record<string, unknown>, required = Object.keys(properties)): T {
  assertSchema(input, { type: "object", properties, required, additionalProperties: false }, "快速执行请求");
  return input as T;
}
type Params = { id: string };
type Start = { requestId: string; revision: number; confirmationToken?: string };

export function registerQuickLaunchRoutes(app: FastifyInstance, service: QuickLaunchService) {
  app.get<{ Querystring: NonNullable<Parameters<QuickLaunchService["list"]>[0]> }>("/api/quick-launches", async request => service.list(request.query));
  app.get("/api/quick-launch-targets", async () => ({ items: service.listTargets() }));
  app.get<{ Params: Params }>("/api/quick-launches/:id", async request => service.get(request.params.id));
  app.post("/api/quick-launches", async (request, reply) => reply.code(201).send(service.save(null, parse<CardInput>(request.body, card))));
  app.patch<{ Params: Params }>("/api/quick-launches/:id", async request =>
    service.save(request.params.id, parse<CardInput & { revision: number }>(request.body, { ...card, revision })));
  app.delete<{ Params: Params }>("/api/quick-launches/:id", async request => {
    const input = parse<{ revision: number; requestId: string }>(request.body, { revision, requestId });
    return service.delete(request.params.id, input.revision, input.requestId);
  });
  app.post<{ Params: Params }>("/api/quick-launches/:id/copy", async request =>
    service.copy(request.params.id, parse<{ requestId: string }>(request.body, { requestId }).requestId));
  app.post<{ Params: Params }>("/api/quick-launches/:id/confirmation", async request =>
    service.confirmation(request.params.id, parse<Start>(request.body, { requestId, revision })));
  app.post<{ Params: Params }>("/api/quick-launches/:id/executions", async (request, reply) =>
    reply.code(202).send(service.start(request.params.id, parse<Start>(request.body,
      { revision, requestId, confirmationToken: { type: "string", maxLength: 80 } }, ["revision", "requestId"]))));
  app.get<{ Querystring: Parameters<QuickLaunchService["history"]>[0] }>("/api/executions", async request => service.history(request.query));
  app.get<{ Params: Params }>("/api/executions/:id", async request => service.detail(request.params.id));
  app.post<{ Params: Params }>("/api/executions/:id/cancel", async request => service.cancel(request.params.id));
  app.post<{ Params: Params }>("/api/executions/:id/end-tracking", async request =>
    service.endTracking(request.params.id, parse<{ reason: string }>(request.body, { reason: { type: "string", minLength: 1, maxLength: 500 } }).reason));
}
