import { connect } from "node:net";
import type { Readable } from "node:stream";
import { AppError, check } from "../domain/errors.js";
import { JsonLinePeer, REQUEST_BYTES, RESPONSE_BYTES, mac, matches, nonce, record, type BridgeBootstrap, type BridgeRole } from "./maintenance-ipc-wire.js";

interface Pending { id: number; frame: string; resolve(value: unknown): void; reject(error: Error): void }
/** Trusted helper client. Bootstrap ONLY from a dedicated inherited pipe. No
 * auto-reconnect, generic network destinations, environment/argv credentials or
 * model-accessible connection configuration. Public instance serialization is {}. */
export class MaintenanceBridgeClient {
  #peer: JsonLinePeer;
  #queue: Pending[] = []; #bytes = 0; #sequence = 0; #pending: Pending | undefined;
  #closed = false; #authenticated = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #ready: Promise<void>; #resolve!: () => void; #reject!: (error: Error) => void;
  #done: Promise<void>; #closedResolve!: () => void;
  private constructor(info: BridgeBootstrap) {
    this.#ready = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
    this.#done = new Promise(resolve => { this.#closedResolve = resolve; });
    const socket = connect({ host: "127.0.0.1", port: info.port }); socket.setNoDelay(true);
    const clientNonce = nonce();
    this.#peer = new JsonLinePeer(socket, () => this.#authenticated ? RESPONSE_BYTES : 4096, async value => {
      if (!this.#authenticated) {
        record(value, ["version", "nonce", "proof"]);
        check(value.version === 1 && typeof value.nonce === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value.nonce) &&
          matches(value.proof, mac(info.secret, "server", info.role, clientNonce, value.nonce)), "BRIDGE_AUTH_INVALID", "私有工具服务认证失败", 403);
        this.#authenticated = true; if (this.#timer) clearTimeout(this.#timer); this.#resolve(); return;
      }
      const response = value as { id?: unknown; ok?: unknown; result?: unknown; code?: unknown };
      check(this.#pending && response.id === this.#pending.id && typeof response.ok === "boolean", "BRIDGE_PROTOCOL_INVALID", "私有工具响应序号无效", 403);
      record(value, response.ok ? ["id", "ok", "result"] : ["id", "ok", "code"]);
      const pending = this.#pending; this.#pending = undefined; this.#bytes -= Buffer.byteLength(pending.frame);
      if (this.#timer) clearTimeout(this.#timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new AppError("BRIDGE_REQUEST_FAILED", "受控工具请求未完成", 409));
      this.#pump();
    }, () => { this.#fail(); this.#closedResolve(); });
    this.#timer = setTimeout(() => this.#fail(), 3000); this.#timer.unref();
    socket.once("connect", () => {
      void this.#peer.send({ version: 1, role: info.role, nonce: clientNonce, proof: mac(info.secret, "client", info.role, clientNonce) }).catch(() => this.#fail());
    });
  }
  static async fromPrivateBootstrap(source: Readable, expectedRole?: BridgeRole): Promise<MaintenanceBridgeClient> {
    const timer = setTimeout(() => source.destroy(new AppError("BRIDGE_BOOTSTRAP_FAILED", "私有启动管道超时", 503)), 3000); timer.unref();
    let bytes = 0; const parts: Buffer[] = [];
    try {
      for await (const chunk of source) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += part.length; check(bytes <= 4096, "BRIDGE_BOOTSTRAP_FAILED", "私有启动记录超限", 503); parts.push(part);
      }
      const info: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes)));
      record(info, ["version", "host", "port", "role", "secret"]);
      check(info.version === 1 && info.host === "127.0.0.1" && typeof info.port === "number" && Number.isSafeInteger(info.port) && info.port >= 1 && info.port <= 65535 &&
        (info.role === "reader" || info.role === "mcp") && (!expectedRole || info.role === expectedRole) && typeof info.secret === "string" && /^[a-zA-Z0-9_-]{43}$/.test(info.secret), "BRIDGE_BOOTSTRAP_FAILED", "私有启动记录无效", 503);
      const client = new MaintenanceBridgeClient(info as unknown as BridgeBootstrap);
      await client.#ready; return client;
    } catch { source.destroy(); throw new AppError("BRIDGE_BOOTSTRAP_FAILED", "私有工具连接未建立", 503); }
    finally { clearTimeout(timer); }
  }
  request(method: "read" | "ls" | "find" | "grep" | "mcp", params: unknown): Promise<unknown> {
    try {
      check(!this.#closed && this.#authenticated, "BRIDGE_CLOSED", "私有工具通道已关闭", 409);
      const id = this.#sequence + 1, frame = JSON.stringify({ id, method, params });
      check(Number.isSafeInteger(id) && Buffer.byteLength(frame) <= REQUEST_BYTES && this.#queue.length + (this.#pending ? 1 : 0) < 8 && this.#bytes + Buffer.byteLength(frame) <= 10 * 1024 * 1024,
        "BRIDGE_INPUT_LIMIT", "私有工具并发或输入超过预算", 409);
      this.#sequence = id; this.#bytes += Buffer.byteLength(frame);
      return new Promise((resolve, reject) => { this.#queue.push({ id, frame, resolve, reject }); this.#pump(); });
    } catch (error) { return Promise.reject(error); }
  }
  #pump() {
    if (this.#closed || this.#pending || !this.#queue.length) return;
    const next = this.#queue.shift()!; this.#pending = next;
    this.#timer = setTimeout(() => this.#fail(), 30000); this.#timer.unref();
    // Peer serializes a parsed object, keeping one framing/byte limit contract.
    void this.#peer.send(JSON.parse(next.frame), REQUEST_BYTES).catch(() => this.#fail());
  }
  #fail() {
    if (this.#closed) return; this.#closed = true; if (this.#timer) clearTimeout(this.#timer);
    const error = new AppError("BRIDGE_CLOSED", "私有工具通道已关闭", 409);
    this.#reject(error); this.#pending?.reject(error); this.#pending = undefined;
    for (const request of this.#queue) request.reject(error); this.#queue = []; this.#bytes = 0; this.#peer.destroy();
  }
  get closed(): Promise<void> { return this.#done; }
  close(): Promise<void> { this.#fail(); return this.#done; }
}
