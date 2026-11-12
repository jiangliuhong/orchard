import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { AppError, check } from "../domain/errors.js";

export type BridgeRole = "reader" | "mcp";
export interface BridgeBootstrap { version: 1; host: "127.0.0.1"; port: number; role: BridgeRole; secret: string }
export const REQUEST_BYTES = 9 * 1024 * 1024;
export const RESPONSE_BYTES = 512 * 1024;
export const nonce = () => randomBytes(32).toString("base64url");
export const mac = (secret: string, ...parts: string[]) => createHmac("sha256", secret).update(parts.join(":")).digest("hex");
export function matches(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
export function record(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
    "BRIDGE_PROTOCOL_INVALID", "私有工具通道协议无效", 403);
}

/** One bounded frame at a time. Neither endpoint accepts pipelining, invalid
 * UTF-8, unbounded partial frames, raw native diagnostics or HTTP requests. */
export class JsonLinePeer {
  #parts: Buffer[] = []; #bytes = 0; #dead = false; #busy = false;
  constructor(readonly socket: Socket, limit: () => number, receive: (value: unknown) => Promise<void>, closed: () => void) {
    socket.on("error", () => {});
    socket.on("close", () => { this.#dead = true; this.#parts = []; closed(); });
    socket.on("end", () => this.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (this.#dead || this.#busy) { this.destroy(); return; }
      const newline = chunk.indexOf(10), size = newline < 0 ? chunk.length : newline;
      if (this.#bytes + size > limit() || newline >= 0 && newline !== chunk.length - 1) { this.destroy(); return; }
      this.#parts.push(chunk.subarray(0, size)); this.#bytes += size;
      if (newline < 0) return;
      socket.pause(); this.#busy = true;
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.#parts, this.#bytes))); }
      catch { this.destroy(); return; }
      this.#parts = []; this.#bytes = 0;
      void Promise.resolve().then(() => receive(value)).then(() => { this.#busy = false; if (!this.#dead) socket.resume(); }, () => this.destroy());
    });
  }
  send(value: unknown, limit = RESPONSE_BYTES): Promise<void> {
    check(!this.#dead && !this.socket.destroyed, "BRIDGE_CLOSED", "私有工具通道已关闭", 409);
    const text = JSON.stringify(value);
    check(typeof text === "string" && Buffer.byteLength(text) <= limit, "BRIDGE_OUTPUT_LIMIT", "私有工具记录超过预算", 409);
    return new Promise((resolve, reject) => this.socket.write(text + "\n", error => error ? reject(new AppError("BRIDGE_CLOSED", "私有工具通道已关闭", 409)) : resolve()));
  }
  destroy(): void { this.#dead = true; this.#parts = []; this.socket.destroy(); }
}
