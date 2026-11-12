import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { AppError, check } from "../domain/errors.js";
import { MaintenanceBridgeClient } from "./maintenance-ipc-client.js";
import { REQUEST_BYTES, RESPONSE_BYTES } from "./maintenance-ipc-wire.js";

/** Platform-owned MCP stdio helper. stdin/stdout contain ONLY MCP messages;
 * startup credentials arrive on a separate inherited pipe, not CLI arguments,
 * environment, MCP configuration files or the model transcript. No default
 * directory/session discovery and no fallback to native filesystem/SQL tools. */
export async function runMaintenanceMcpStdio(input: { bootstrap: Readable; stdin: Readable; stdout: Writable; signal: AbortSignal }): Promise<void> {
  input.signal.throwIfAborted();
  // A late stream error must not become an uncaught native diagnostic after a
  // write callback rejects; individual writes still report controlled failure.
  input.stdout.on("error", () => {});
  const client = await MaintenanceBridgeClient.fromPrivateBootstrap(input.bootstrap, "mcp");
  let running = true;
  void client.closed.then(() => { if (running) input.stdin.destroy(new AppError("BRIDGE_CLOSED", "私有工具通道已关闭", 409)); });
  const abort = () => { input.stdin.destroy(); void client.close(); };
  input.signal.addEventListener("abort", abort, { once: true });
  let parts: Buffer[] = [], bytes = 0;
  try {
    input.signal.throwIfAborted();
    for await (const value of input.stdin) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); let start = 0;
      for (;;) {
        input.signal.throwIfAborted();
        const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
        check(bytes + end - start <= REQUEST_BYTES, "BRIDGE_INPUT_LIMIT", "MCP 输入记录超过预算", 409);
        parts.push(chunk.subarray(start, end)); bytes += end - start;
        if (newline < 0) break;
        const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes)));
        parts = []; bytes = 0;
        const result = await client.request("mcp", record); input.signal.throwIfAborted();
        if (result !== null) {
          const text = JSON.stringify(result) + "\n"; check(Buffer.byteLength(text) <= RESPONSE_BYTES, "BRIDGE_OUTPUT_LIMIT", "MCP 输出记录超过预算", 409);
          await new Promise<void>((resolve, reject) => {
            const failed = () => { input.stdout.off("error", failed); reject(new AppError("BRIDGE_CLOSED", "MCP 输出通道已关闭", 409)); };
            input.stdout.once("error", failed);
            input.stdout.write(text, error => { input.stdout.off("error", failed); if (error) failed(); else resolve(); });
          });
        }
        start = newline + 1;
        if (start === chunk.length) break;
      }
    }
    check(bytes === 0, "BRIDGE_PROTOCOL_INVALID", "MCP 输入记录不完整", 409);
  } finally { running = false; input.signal.removeEventListener("abort", abort); input.bootstrap.destroy(); await client.close(); }
}

// This is a trusted package entry point, never an Agent-generated command.
// The future verified launcher must deliberately allocate inherited descriptor 3.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort(); process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    check(process.argv.length === 2, "BRIDGE_BOOTSTRAP_FAILED", "MCP 桥接不接受连接参数");
    await runMaintenanceMcpStdio({ bootstrap: createReadStream("", { fd: 3, autoClose: true }), stdin: process.stdin, stdout: process.stdout, signal: controller.signal });
  } catch { process.stderr.write("ORCHARD_MAINTENANCE_BRIDGE_FAILED\n"); process.exitCode = 1; }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
