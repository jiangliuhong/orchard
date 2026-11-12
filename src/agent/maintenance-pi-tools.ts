import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { maintenanceReadSchemas, type MaintenanceReadMethod } from "./maintenance-file-protocol.js";

export const MAINTENANCE_PI_TOOLS = Object.freeze(["read", "ls", "find", "grep", "mcp__orchard__submit_proposal", "mcp__orchard__apply_proposal", "mcp__orchard__proposal_status"]);
interface Channel { closed: Promise<void>; close(): Promise<void> }
export interface MaintenancePiChannels {
  reader: Channel & { request(method: MaintenanceReadMethod, params: unknown): Promise<unknown> };
  mcp: Channel & { request(method: "initialize" | "tools/list" | "tools/call", params?: unknown): Promise<unknown> };
}
export interface MaintenancePiTool {
  name: string; label: string; description: string; parameters: Record<string, unknown>;
  execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ content: { type: "text"; text: string }[]; details: unknown; isError?: boolean }>;
}
/** Structural subset of Pi 1.5.2's extension API; no runtime Pi dependency in
 * Orchard. The verified launcher MUST disable discovery and all other extensions.
 * This adapter is not an OS sandbox or permission to enable a Provider. */
export interface MaintenancePiApi {
  registerTool(tool: MaintenancePiTool): void;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: string, handler: (event: { toolName?: string; text?: string }) => unknown): void;
}

export async function registerMaintenancePiTools(pi: MaintenancePiApi, channels: MaintenancePiChannels) {
  let ready = false, stopped = false;
  const close = async () => { stopped = true; ready = false; await Promise.allSettled([channels.reader.close(), channels.mcp.close()]); };
  void channels.reader.closed.then(close); void channels.mcp.closed.then(close);
  const valid = () => {
    const active = pi.getActiveTools();
    return ready && !stopped && active.length === MAINTENANCE_PI_TOOLS.length && new Set(active).size === active.length && active.every(name => MAINTENANCE_PI_TOOLS.includes(name));
  };
  // Install BEFORE any asynchronous initialization. RPC bash has a separate
  // dispatch path in Pi, so an inactive bash tool alone is insufficient.
  pi.on("user_bash", () => ({ result: { output: "ORCHARD_MAINTENANCE_SHELL_DENIED", exitCode: 1, cancelled: false, truncated: false } }));
  pi.on("tool_call", event => valid() && MAINTENANCE_PI_TOOLS.includes(event.toolName ?? "") ? undefined : { block: true, terminate: true, reason: "ORCHARD_MAINTENANCE_TOOL_DENIED" });
  pi.on("input", event => !valid() || /^\s*[!/]/.test(event.text ?? "") ? { action: "handled" } : undefined);
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("session_before_tree", () => ({ cancel: true }));
  pi.on("session_before_compact", () => ({ cancel: true }));
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("session_shutdown", close);
  const failed = () => new AppError("MAINTENANCE_TOOL_FAILED", "维护工具请求未完成，请查看平台状态", 409);
  const execute = async (signal: AbortSignal | undefined, operation: () => Promise<unknown>) => {
    if (!valid() || signal?.aborted) { await close(); throw failed(); }
    const abort = () => { void close(); }; signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await operation();
      if (!valid() || signal?.aborted) throw failed();
      return result;
    } catch { throw failed(); }
    finally { signal?.removeEventListener("abort", abort); }
  };
  try {
    const initialized = await channels.mcp.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "orchard-pi-maintenance", version: "1" } });
    assertSchema(initialized, { type: "object", required: ["protocolVersion", "serverInfo", "capabilities"], properties: {
      protocolVersion: { const: "2025-11-25" }, serverInfo: { type: "object", required: ["name", "version"], properties: { name: { const: "orchard-maintenance" }, version: { const: "1" } }, additionalProperties: false },
      capabilities: { const: { tools: {} } },
    }, additionalProperties: false }, "维护 MCP 握手");
    const listed = await channels.mcp.request("tools/list");
    assertSchema(listed, { type: "object", required: ["tools"], properties: { tools: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", required: ["name", "description", "inputSchema"], properties: {
      name: { enum: ["submit_proposal", "apply_proposal", "proposal_status"] }, description: { type: "string", maxLength: 4000 }, inputSchema: { type: "object" }, annotations: { type: "object" },
    }, additionalProperties: false } } }, additionalProperties: false }, "维护 MCP 工具");
    const tools = (listed as { tools: { name: string; description: string; inputSchema: Record<string, unknown> }[] }).tools;
    check(new Set(tools.map(tool => tool.name)).size === 3, "MAINTENANCE_TOOL_FAILED", "维护工具清单不完整");
    for (const name of Object.keys(maintenanceReadSchemas) as MaintenanceReadMethod[]) pi.registerTool({
      name, label: name, description: `Read-only verified workspace ${name}; no shell or host filesystem access.`, parameters: maintenanceReadSchemas[name],
      execute: async (_id, params, signal) => {
        const value = await execute(signal, async () => { assertSchema(params, maintenanceReadSchemas[name], "工作区读取"); return channels.reader.request(name, params); });
        return { content: [{ type: "text", text: JSON.stringify(value) }], details: {} };
      },
    });
    for (const tool of tools) pi.registerTool({
      name: `mcp__orchard__${tool.name}`, label: tool.name, description: tool.description, parameters: tool.inputSchema,
      execute: async (_id, params, signal) => {
        const result = await execute(signal, async () => {
          assertSchema(params, tool.inputSchema, "维护提案工具");
          const value = await channels.mcp.request("tools/call", { name: tool.name, arguments: params });
          assertSchema(value, { type: "object", required: ["content", "isError"], properties: {
            content: { type: "array", minItems: 1, maxItems: 1, items: { type: "object", required: ["type", "text"], properties: { type: { const: "text" }, text: { type: "string", maxLength: 65536 } }, additionalProperties: false } },
            structuredContent: {}, isError: { type: "boolean" },
          }, additionalProperties: false }, "维护工具响应");
          return value;
        });
        const value = result as { content: { type: "text"; text: string }[]; isError: boolean };
        // Pi marks an execution as failed on a thrown error, not an arbitrary
        // `isError` property in the returned ToolResult (MCP uses that property).
        if (value.isError) throw failed();
        return { content: value.content, details: {} };
      },
    });
    check(!stopped, "MAINTENANCE_TOOL_FAILED", "初始化期间通道已关闭");
    pi.setActiveTools([...MAINTENANCE_PI_TOOLS]); ready = true;
    check(valid(), "MAINTENANCE_TOOL_FAILED", "维护工具激活失败");
    return { close, assertReady: () => { if (!valid()) throw failed(); } };
  } catch { await close(); throw failed(); }
}
