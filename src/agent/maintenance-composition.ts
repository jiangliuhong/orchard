import { check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import type { MaintenanceBoundary } from "./maintenance-service.js";
import { requireWorkspaceBusinessTracking } from "./workspace-business-hooks.js";
import type { FastifyRequest } from "fastify";
import type { MaintenanceSessions } from "./maintenance-sessions.js";
import type { MaintenanceTarget } from "./maintenance-protocol.js";

export interface MaintenanceTaskApi {
  start(actor: string, kind: MaintenanceTarget["kind"], owner: string, input: { requestId: string; prompt: string }): ReturnType<MaintenanceSessions["enqueue"]>;
  list(actor: string, sessionId: string): ReturnType<MaintenanceSessions["tasks"]>;
}

/** Supplied ONLY by the platform's trusted composition code. There is no JSON,
 * HTTP, environment flag, permissive default or DB-status-derived stop proof. */
export interface MaintenanceRuntimeAuthority {
  boundary: MaintenanceBoundary;
  /** Recover persisted task state before any legacy business recovery or worker startup. */
  recover?(): void | Promise<void>;
  authorizeUserRequest?(request: FastifyRequest): string;
  tasks?: MaintenanceTaskApi;
  close?(): void | Promise<void>;
}
export type MaintenanceRuntimeFactory = (store: Store) => MaintenanceRuntimeAuthority;

export function createMaintenanceAuthority(store: Store, factory: MaintenanceRuntimeFactory) {
  requireWorkspaceBusinessTracking(store);
  const authority = factory(store);
  const asynchronous = authority && typeof (authority as unknown as { then?: unknown }).then === "function";
  if (asynchronous) void Promise.resolve(authority).catch(() => {});
  let closing: Promise<void> | undefined;
  // The root must register close before accessing boundary: even a malformed
  // returned authority may already own resources that need failure cleanup.
  return {
    get tasks() { return authority.tasks; },
    get boundary(): MaintenanceBoundary {
      check(!asynchronous && authority && authority.boundary && ["authorize", "knownSecrets", "assertQuiescent", "synchronize"].every(key => typeof authority.boundary[key as keyof MaintenanceBoundary] === "function") &&
        (authority.close === undefined || typeof authority.close === "function"), "MAINTENANCE_RUNTIME_INVALID", "维护宿主缺少真实授权、停机证明或投影同步能力", 503);
      return authority.boundary;
    },
    recover: async () => { await authority.recover?.(); },
    authorizeUserRequest(request: FastifyRequest): string {
      check(typeof authority.authorizeUserRequest === "function", "MAINTENANCE_RUNTIME_REQUIRED", "维护页面尚未接入可信身份验证", 503);
      return authority.authorizeUserRequest(request);
    },
    close: () => closing ??= Promise.resolve().then(() => typeof authority?.close === "function" ? authority.close() : undefined),
  };
}
