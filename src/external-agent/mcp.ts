import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../domain/errors.js";
import type { QuickLaunchCommands } from "../cli/quick-launch.js";
import { inProgress } from "./client.js";

const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const statusTool = "orchard_execution_status";
const toolPattern = /^orchard_([a-f0-9-]{36})_([1-9][0-9]*)$/;
const idPattern = /^[a-f0-9-]{36}$/;
const content = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError } : {}),
});

export async function serveAgentMcp(commands: QuickLaunchCommands) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const tools = async (autoStart: boolean) => {
    const { items } = await commands.list(autoStart).catch(error => {
      if (error instanceof AppError && error.code === "AGENT_ACCESS_DISABLED") return { items: [] };
      throw error;
    });
    if (!items.length) return [];
    return [...items.map(item => ({
      name: `orchard_${item.id}_${item.revision}`, title: item.name,
      description: `运行 Orchard 快速执行卡片「${item.name}」，使用卡片保存的参数。${item.note ? " " + item.note : ""}`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    })), {
      name: statusTool, description: "查询同一 MCP 入口发起的 Orchard 执行状态及可用结果。",
      inputSchema: { type: "object", properties: { executionId: { type: "string", pattern: idPattern.source } },
        required: ["executionId"], additionalProperties: false },
      annotations: { readOnlyHint: true },
    }];
  };
  let catalog: string | undefined;
  let refreshing = false;
  let phase: "new" | "initializing" | "ready" = "new";
  const watcher = setInterval(async () => {
    if (catalog === undefined || refreshing) return;
    refreshing = true;
    try {
      const next = JSON.stringify(await tools(false));
      if (catalog !== next) { catalog = next; send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); }
    } catch { /* A temporary connection failure doesn't change permissions. */ }
    finally { refreshing = false; }
  }, 3000);
  watcher.unref();
  type RpcId = string | number | null;
  const respond = (id: RpcId, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcId, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(line: string) {
    let message;
    try { message = JSON.parse(line); } catch { return fail(null, -32700, "Parse error"); }
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(null, -32600, "Invalid request");
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === "notifications/initialized" && phase === "initializing") phase = "ready";
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") return fail(null, -32600, "Invalid request ID");
    if (method === "initialize" && phase === "new") {
      if (typeof params?.protocolVersion !== "string") return fail(id, -32602, "Invalid protocol version");
      phase = "initializing";
      return respond(id, {
        protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: { listChanged: true } }, serverInfo: { name: "orchard", version: "1.0.0" },
      });
    }
    if (method === "ping") return respond(id, {});
    if (phase !== "ready") return fail(id, -32002, "Server not initialized");
    if (method === "tools/list") {
      try {
        const listed = await tools(true);
        catalog = JSON.stringify(listed);
        return respond(id, { tools: listed });
      } catch (error) { return fail(id, -32000, error instanceof Error ? error.message : "无法读取 Orchard 工具"); }
    }
    if (method !== "tools/call") return fail(id, -32601, "Method not found");
    if (typeof params?.name !== "string") return fail(id, -32602, "Invalid tool name");
    const args = params.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return fail(id, -32602, "Invalid tool arguments");
    const match = toolPattern.exec(params.name);
    if (!match && params.name !== statusTool) return fail(id, -32602, "Unknown tool");
    try {
      if (!match) {
        if (Object.keys(args).length !== 1 || typeof args.executionId !== "string" || !idPattern.test(args.executionId))
          return fail(id, -32602, "Invalid execution ID");
        return respond(id, content(await commands.status(args.executionId, false)));
      }
      if (Object.keys(args).length) return fail(id, -32602, "此卡片使用固定参数");
      let result = await commands.run(match[1], Number(match[2]));
      // Give short runs a chance to return output in one call. Keep the receipt if polling fails.
      const deadline = Date.now() + 4000;
      while (inProgress(result) && Date.now() < deadline) {
        await delay(250);
        try { result = await commands.status(result.executionId, false); } catch { break; }
      }
      return respond(id, content(result, !inProgress(result) && result.status !== "succeeded"));
    } catch (error) {
      return respond(id, content({ code: error instanceof AppError ? error.code : "AGENT_ACCESS_FAILED",
        message: error instanceof Error ? error.message : "Orchard 调用失败" }, true));
    }
  }
  try {
    for await (const line of input) {
      if (Buffer.byteLength(line) > 65536) fail(null, -32600, "Request too large");
      else if (line.trim()) await handle(line);
    }
  } finally { clearInterval(watcher); }
}
