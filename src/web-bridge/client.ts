import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { AppError } from "../domain/errors.js";
import { decodeLine, encodeLine, type BridgeResponse } from "./protocol.js";

export class WebBridgeClient {
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private socket?: Socket;
  private buffer = "";
  constructor(readonly socketPath: string, public catalogHash: string) {}
  async call(tool: string, args: unknown, options: { timeoutMs: number; signal?: AbortSignal; requestId?: string }) {
    const socket = await this.connect(options.timeoutMs);
    const id = options.requestId ?? randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError("BROWSER_TIMEOUT", "浏览器调用超时")); this.close(); }, options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeLine({ id, tool, args, catalogHash: this.catalogHash }));
    });
    const abort = () => { const item = this.pending.get(id); if (item) { clearTimeout(item.timer); this.pending.delete(id); item.reject(new AppError("CANCELLED", "调用已取消")); this.close(); } };
    options.signal?.addEventListener("abort", abort, { once: true });
    try { return await result; } finally { options.signal?.removeEventListener("abort", abort); }
  }
  async status() {
    try { await this.connect(1000); return { connected: true }; } catch { return { connected: false }; }
  }
  private connect(timeoutMs: number) {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath), timer = setTimeout(() => { socket.destroy(); reject(new AppError("BROWSER_NOT_CONNECTED", "浏览器桥接未连接")); }, timeoutMs);
      const fail = (error: unknown) => { clearTimeout(timer); this.socket = undefined; reject(new AppError("BROWSER_NOT_CONNECTED", error instanceof Error ? error.message : "浏览器桥接未连接")); };
      socket.once("connect", () => { clearTimeout(timer); this.socket = socket; socket.on("data", chunk => this.onData(chunk.toString("utf8"))); socket.on("close", () => this.failAll(new AppError("BROWSER_DISCONNECTED", "浏览器桥接已断开"))); resolve(socket); });
      socket.once("error", fail);
    });
  }
  private onData(chunk: string) {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const at = this.buffer.indexOf("\n"), line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      let response: BridgeResponse;
      try { response = decodeLine(line) as BridgeResponse; } catch { continue; }
      const item = this.pending.get(response.id); if (!item) continue;
      clearTimeout(item.timer); this.pending.delete(response.id);
      response.error ? item.reject(new AppError(response.error.code, response.error.message)) : item.resolve(response.result);
    }
  }
  private failAll(error: Error) { for (const [id, item] of this.pending) { clearTimeout(item.timer); item.reject(error); this.pending.delete(id); } }
  close() { this.failAll(new AppError("BROWSER_DISCONNECTED", "浏览器桥接已断开")); this.socket?.destroy(); this.socket = undefined; }
}
