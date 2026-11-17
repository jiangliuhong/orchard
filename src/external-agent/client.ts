import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppError, check } from "../domain/errors.js";
import { readPolicy, type Channel } from "./policy.js";

export type Tool = { id: string; name: string; note: string; revision: number; kind: "script" | "browser_tool" };
export type Result = { executionId: string; name: string; status: string; outputAvailability: string; output?: unknown };
export const inProgress = (result: Result) => ["accepted", "queued", "running", "cancel_requested"].includes(result.status);

export function agentClient(root: string, port: number, channel: Channel) {
  check(Number.isInteger(port) && port >= 1 && port <= 65535, "INVALID_PORT", "端口必须为 1–65535");
  const base = `http://127.0.0.1:${port}`;
  const path = `/api/agent-access/${channel}`;
  let startup: Promise<void> | undefined;
  const send = (path: string, options?: RequestInit) => fetch(base + path, {
    ...options, redirect: "error", signal: AbortSignal.timeout(3000),
  });
  const reachable = () => send("/api/health").catch(() => undefined);
  async function start() {
    let health = await reachable();
    if (!health) {
      const development = import.meta.url.endsWith(".ts");
      const main = fileURLToPath(new URL(development ? "../server/main.ts" : "../server/main.js", import.meta.url));
      const loader = development ? ["--import", import.meta.resolve("tsx")] : [];
      const child = spawn(process.execPath, [...loader, main, "--data-dir", root, "--port", String(port)], {
        detached: true, stdio: "ignore",
      });
      child.on("error", () => {});
      child.unref();
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      health ??= await reachable();
      if (health) {
        const state = await health.json().catch(() => null) as { application?: string; ready?: boolean } | null;
        check(state?.application === "orchard-workbench", "PORT_IN_USE", "端口上运行的服务不是 Orchard", 409);
        if (state.ready) return;
      }
      health = undefined;
      await delay(200);
    }
    throw new AppError("SERVER_NOT_READY", "Orchard 未能就绪，请检查端口、数据目录及升级状态", 503);
  }
  async function request<T>(route: string, body?: unknown, autoStart = true): Promise<T> {
    check(readPolicy(root)[channel].enabled, "AGENT_ACCESS_DISABLED", "请在 Orchard 设置中启用此入口", 403);
    if (autoStart) {
      startup ??= start().finally(() => { startup = undefined; });
      await startup;
    }
    let token: string;
    try { token = readFileSync(join(root, "runtime", "api-token"), "utf8").trim(); }
    catch { throw new AppError("SERVER_NOT_READY", "找不到此数据目录的本机 API 凭据", 503); }
    const response = await send(path + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-orchard-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => { throw new AppError("SERVER_UNREACHABLE", "无法连接 Orchard。执行请求超时后，请先检查运行记录再重试。", 503); });
    const result = await response.json() as { code?: string; message?: string };
    check(response.ok, result.code ?? "AGENT_ACCESS_FAILED", result.message ?? "Orchard 调用失败", response.status);
    return result as T;
  }
  return {
    list: (autoStart = true) => request<{ items: Tool[] }>("/tools", undefined, autoStart).then(result => result.items),
    run: (id: string, revision: number, requestId: string) =>
      request<Result>(`/tools/${encodeURIComponent(id)}`, { revision, requestId }),
    runBridge: (input: { application: string; tool: string; args: unknown; environmentId?: string; requestId: string }) =>
      request<Result>("/legacy-web-bridge", input),
    status: (id: string, autoStart = false) => request<Result>(`/executions/${encodeURIComponent(id)}`, undefined, autoStart),
  };
}
