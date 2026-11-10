import type { FastifyInstance } from "fastify";
import { AppError } from "../domain/errors.js";
import type { GitProjects } from "./service.js";
import type { StorageUsageService } from "../storage/usage.js";
import { assertSchema } from "../domain/validation.js";

export function registerProjectRoutes(app: FastifyInstance, projects: () => GitProjects, storage: () => StorageUsageService) {
  const safe = <T>(action: () => T): T => {
    try { return action(); } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("PROJECT_CONFIG_FAILED", "本机项目配置不可用，请检查文件权限或格式");
    }
  };
  const empty = (body: unknown) => assertSchema(body ?? {}, { type: "object", additionalProperties: false }, "请求");
  app.get("/api/git-projects", async () => safe(() => ({ items: projects().list() })));
  app.post("/api/git-projects", async request => safe(() => projects().save(request.body)));
  app.patch<{ Params: { id: string } }>("/api/git-projects/:id", async request => safe(() => projects().save(request.body, request.params.id)));
  app.get("/api/git-ssh-profiles", async () => safe(() => ({ items: projects().profileViews() })));
  app.post<{ Params: { id: string } }>("/api/git-projects/:id/check", async (request, reply) => {
    empty(request.body); const operation = safe(() => projects().check(request.params.id)); reply.code(202); return { operationId: operation.id };
  });
  app.get<{ Params: { id: string } }>("/api/git-project-operations/:id", async request => safe(() => projects().operation(request.params.id)));
  app.get("/api/storage/usage", async () => storage().view());
  app.post("/api/storage/usage/scan", async (request, reply) => { empty(request.body); reply.code(202); return { scanId: storage().start().scanId }; });
  app.get<{ Params: { id: string } }>("/api/storage/usage/scans/:id", async request => storage().get(request.params.id));
}
