import type { FastifyInstance } from "fastify";
import { assertSchema } from "../domain/validation.js";
import type { QuickLaunchGroups, GroupChange } from "./groups.js";

const requestId = { type: "string", minLength: 1, maxLength: 200 };
const groupId = { type: ["string", "null"], minLength: 1, maxLength: 200 };
const groupFields = { name: { type: "string", minLength: 1, maxLength: 200 }, parentId: groupId, requestId };

function parse<T>(value: unknown, properties: Record<string, unknown>): T {
  assertSchema(value, { type: "object", properties, required: Object.keys(properties), additionalProperties: false }, "分组请求");
  return value as T;
}

export function registerQuickLaunchGroupRoutes(app: FastifyInstance, groups: QuickLaunchGroups) {
  app.get("/api/quick-launch-groups", async () => ({ items: groups.list() }));
  app.post("/api/quick-launch-groups", async (request, reply) => {
    const group = groups.create(parse<GroupChange>(request.body, groupFields));
    return reply.code(201).send(group);
  });
  app.patch<{ Params: { id: string } }>("/api/quick-launch-groups/:id", async request =>
    groups.update(request.params.id, parse<GroupChange & { revision: number }>(request.body, {
      ...groupFields, revision: { type: "integer", minimum: 1 }
    })));
  app.post<{ Params: { id: string } }>("/api/quick-launch-groups/:id/deletion-preview", async request =>
    groups.preview(request.params.id));
  app.delete<{ Params: { id: string } }>("/api/quick-launch-groups/:id", async request =>
    groups.delete(request.params.id, parse(request.body, {
      requestId, destinationGroupId: groupId, previewToken: { type: "string", maxLength: 80 }
    })));
}
