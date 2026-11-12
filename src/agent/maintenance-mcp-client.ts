import type { Readable, Writable } from "node:stream";
import { AppError, check } from "../domain/errors.js";
import { REQUEST_BYTES, RESPONSE_BYTES, record } from "./maintenance-ipc-wire.js";

interface Pending { id: number; frame: string; resolve(value: unknown): void; reject(error: Error): void }
/** A single private stdio MCP channel. The trusted launcher owns the helper and
 * wires these streams; no command, network address, credentials or discovery
 * configuration is accepted here. Closing pipes is NOT process-exit proof. */
export class MaintenanceMcpClient {
  #queue: Pending[] = []; #pending?: Pending; #sequence = 0; #bytes = 0; #stopped = false;
  #timer?: ReturnType<typeof setTimeout>; #reading: Promise<void>;
  #done: Promise<void>; #resolve!: () => void;
  #input: Readable; #output: Writable;
  constructor(input: Readable, output: Writable) {
    this.#input = input; this.#output = output;
    this.#done = new Promise(resolve => { this.#resolve = resolve; });
    output.on("error", this.#fail); output.once("close", this.#fail);
    this.#reading = this.#read();
    void this.#reading.finally(() => { this.#fail(); this.#resolve(); });
  }
  request(method: "initialize" | "tools/list" | "tools/call", params: unknown = {}): Promise<unknown> {
    try {
      check(!this.#stopped && ["initialize", "tools/list", "tools/call"].includes(method), "MCP_CHANNEL_CLOSED", "维护 MCP 通道不可用", 409);
      const id = this.#sequence + 1, frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      check(Number.isSafeInteger(id) && id <= 4096 && Buffer.byteLength(frame) <= REQUEST_BYTES && this.#queue.length + (this.#pending ? 1 : 0) < 8 && this.#bytes + Buffer.byteLength(frame) <= 10 * 1024 * 1024,
        "MCP_INPUT_LIMIT", "维护 MCP 请求超过预算", 409);
      this.#sequence = id; this.#bytes += Buffer.byteLength(frame);
      return new Promise((resolve, reject) => { this.#queue.push({ id, frame, resolve, reject }); this.#pump(); });
    } catch { return Promise.reject(this.#error()); }
  }
  #pump() {
    if (this.#stopped || this.#pending || !this.#queue.length) return;
    const pending = this.#queue.shift()!; this.#pending = pending;
    this.#timer = setTimeout(this.#fail, 30000); this.#timer.unref();
    this.#output.write(pending.frame, error => { if (error) this.#fail(); });
  }
  async #read() {
    let parts: Buffer[] = [], bytes = 0;
    try {
      for await (const value of this.#input) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); let start = 0;
        for (;;) {
          const newline = chunk.indexOf(10, start), end = newline < 0 ? chunk.length : newline;
          check(bytes + end - start <= RESPONSE_BYTES, "MCP_OUTPUT_LIMIT", "维护 MCP 响应超过预算");
          parts.push(chunk.subarray(start, end)); bytes += end - start;
          if (newline < 0) break;
          const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes)));
          parts = []; bytes = 0;
          check(response && typeof response === "object" && !Array.isArray(response), "MCP_PROTOCOL_INVALID", "维护 MCP 响应无效");
          const result = response as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
          record(response, Object.hasOwn(result, "error") ? ["jsonrpc", "id", "error"] : ["jsonrpc", "id", "result"]);
          check(result.jsonrpc === "2.0" && this.#pending && result.id === this.#pending.id, "MCP_PROTOCOL_INVALID", "维护 MCP 响应序号无效");
          const pending = this.#pending; this.#pending = undefined;
          clearTimeout(this.#timer); this.#bytes -= Buffer.byteLength(pending.frame);
          if (Object.hasOwn(result, "error")) pending.reject(this.#error()); else pending.resolve(result.result);
          this.#pump(); start = newline + 1;
          if (start === chunk.length) break;
        }
      }
    } catch { /* Never copy parser, pipe or server diagnostics into a transcript. */ }
  }
  #error() { return new AppError("MCP_CHANNEL_FAILED", "维护 MCP 通道请求未完成", 409); }
  #fail = () => {
    if (this.#stopped) return; this.#stopped = true; clearTimeout(this.#timer);
    this.#pending?.reject(this.#error()); this.#pending = undefined;
    for (const pending of this.#queue) pending.reject(this.#error());
    this.#queue = []; this.#bytes = 0; this.#input.destroy(); this.#output.destroy();
  };
  get closed(): Promise<void> { return this.#done; }
  async close(): Promise<void> { this.#fail(); await this.#done; }
}
