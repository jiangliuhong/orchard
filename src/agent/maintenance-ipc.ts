import { createServer, type Server, type Socket } from "node:net";
import type { Writable } from "node:stream";
import { AppError, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { MaintenanceMcpConnection, type MaintenanceToolGateway } from "./maintenance-tools.js";
import type { ScopedWorkspaceReader } from "./workspace-files.js";
import { JsonLinePeer, REQUEST_BYTES, mac, matches, nonce, record, type BridgeRole } from "./maintenance-ipc-wire.js";

import { maintenanceReadSchemas } from "./maintenance-file-protocol.js";
const publicCodes = new Set(["WORKSPACE_PATH_DENIED", "WORKSPACE_LEASE_EXPIRED", "WORKSPACE_LINE_TOO_LARGE", "NOT_FOUND", "INVALID_REQUEST", "TOOL_DENIED", "BRIDGE_OUTPUT_LIMIT", "SCHEMA_MISMATCH"]);

/** Task-scoped, mutually authenticated loopback IPC (NOT an HTTP API). No disk
 * sockets or cleanup guesses; no credentials in workspace, argv or environment.
 * Bootstrap goes only through platform-owned inherited pipes. Same-OS-user/admin
 * process access is not an OS sandbox. Real CLI integration remains gated. */
export class PrivateMaintenanceBridge {
  #server: Server;
  #controller = new AbortController();
  #grant: ReturnType<MaintenanceToolGateway["issue"]>;
  #secrets = { reader: nonce(), mcp: nonce() };
  #used = new Set<BridgeRole>();
  #sockets = new Set<Socket>();
  #work = new Set<Promise<void>>();
  #closing = false; #closed = false; #port = 0;
  #done: Promise<void>; #resolve!: () => void;
  #ttl: ReturnType<typeof setTimeout> | undefined;
  #removeSignals: (() => void) | undefined;
  #reader: ScopedWorkspaceReader; #gateway: MaintenanceToolGateway;
  private constructor(input: { reader: ScopedWorkspaceReader; gateway: MaintenanceToolGateway; actor: string; sessionId: string; taskId: string; ttlMs?: number }) {
    this.#reader = input.reader; this.#gateway = input.gateway;
    this.#done = new Promise(resolve => { this.#resolve = resolve; });
    this.#grant = input.gateway.issue({ actor: input.actor, sessionId: input.sessionId, taskId: input.taskId, signal: this.#controller.signal, ttlMs: input.ttlMs });
    try { input.gateway.assertReader(this.#grant.token, input.reader); }
    catch (error) { this.#grant.revoke(); this.#controller.abort(); throw error; }
    this.#server = createServer(socket => this.#accept(socket));
    this.#server.on("error", () => { void this.close(); });
  }
  static async open(input: { reader: ScopedWorkspaceReader; gateway: MaintenanceToolGateway; actor: string; sessionId: string; taskId: string; signal: AbortSignal; ttlMs?: number }) {
    input.signal.throwIfAborted(); input.reader.signal.throwIfAborted();
    const bridge = new PrivateMaintenanceBridge(input);
    try {
      await new Promise<void>((resolve, reject) => {
        const error = () => reject(new AppError("BRIDGE_START_FAILED", "私有工具通道无法启动", 503));
        bridge.#server.once("error", error);
        bridge.#server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { bridge.#server.off("error", error); resolve(); });
      });
      const address = bridge.#server.address();
      check(address && typeof address !== "string" && address.address === "127.0.0.1", "BRIDGE_START_FAILED", "私有工具通道绑定无效", 503);
      bridge.#port = address.port;
      const cancel = () => { void bridge.close(); };
      input.signal.addEventListener("abort", cancel, { once: true }); input.reader.signal.addEventListener("abort", cancel, { once: true }); bridge.#grant.signal.addEventListener("abort", cancel, { once: true });
      bridge.#removeSignals = () => { input.signal.removeEventListener("abort", cancel); input.reader.signal.removeEventListener("abort", cancel); bridge.#grant.signal.removeEventListener("abort", cancel); };
      bridge.#ttl = setTimeout(cancel, input.ttlMs ?? 30 * 60_000); bridge.#ttl.unref();
      input.signal.throwIfAborted(); input.reader.signal.throwIfAborted(); bridge.#grant.signal.throwIfAborted(); bridge.#gate();
      return bridge;
    } catch (error) { await bridge.close(); throw error; }
  }
  get signal(): AbortSignal { return this.#controller.signal; }
  #gate() {
    check(!this.#closing, "BRIDGE_CLOSED", "私有工具通道已关闭", 409);
    this.#gateway.assertReader(this.#grant.token, this.#reader);
  }
  /** Host only: supply a dedicated inherited pipe, never stdout/native stdin.
   * Credentials never travel as model tool arguments or MCP configuration text. */
  writePrivateBootstrap(role: BridgeRole, destination: Writable): Promise<void> {
    this.#gate(); check(role === "reader" || role === "mcp", "INVALID_REQUEST", "私有工具角色无效");
    // Writable errors may be emitted after the write callback. Consume them even
    // when the operation already rejected; never print a raw EPIPE stack.
    destination.on("error", () => {});
    return new Promise((resolve, reject) => {
      const failed = () => { destination.off("error", failed); reject(new AppError("BRIDGE_BOOTSTRAP_FAILED", "私有工具启动管道不可用", 503)); };
      destination.once("error", failed);
      try {
        destination.end(JSON.stringify({ version: 1, host: "127.0.0.1", port: this.#port, role, secret: this.#secrets[role] }) + "\n", (error?: Error | null) => {
          if (error) failed(); else { destination.off("error", failed); resolve(); }
        });
      } catch { failed(); }
    });
  }
  #accept(socket: Socket) {
    if (this.#closing || this.#sockets.size >= 8 || socket.remoteAddress !== "127.0.0.1") { socket.destroy(); return; }
    this.#sockets.add(socket); socket.setNoDelay(true);
    let role: BridgeRole | undefined, sequence = 0, count = 0;
    const authTimer = setTimeout(() => socket.destroy(), 3000); authTimer.unref();
    const mcp = new MaintenanceMcpConnection(this.#gateway, this.#grant.token);
    const peer = new JsonLinePeer(socket, () => role === "mcp" ? REQUEST_BYTES : 4096, async value => {
      // Register work before executing callbacks that can initiate revocation.
      const work = Promise.resolve().then(async () => {
        if (!role) {
          record(value, ["version", "role", "nonce", "proof"]);
          check(value.version === 1 && (value.role === "reader" || value.role === "mcp") && typeof value.nonce === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value.nonce), "BRIDGE_PROTOCOL_INVALID", "私有通道认证无效");
          const candidate = value.role;
          check(!this.#used.has(candidate) && matches(value.proof, mac(this.#secrets[candidate], "client", candidate, value.nonce)), "BRIDGE_AUTH_INVALID", "私有通道认证无效", 403);
          this.#gate(); role = candidate; this.#used.add(role); clearTimeout(authTimer);
          const serverNonce = nonce();
          await peer.send({ version: 1, nonce: serverNonce, proof: mac(this.#secrets[role], "server", role, value.nonce, serverNonce) }); return;
        }
        record(value, ["id", "method", "params"]);
        check(Number.isSafeInteger(value.id) && value.id === sequence + 1 && typeof value.method === "string" && ++count <= 4096, "BRIDGE_PROTOCOL_INVALID", "私有工具序号或预算无效");
        sequence = value.id as number;
        try {
          this.#gate();
          let result: unknown;
          if (role === "mcp") { check(value.method === "mcp", "TOOL_DENIED", "工具角色不匹配", 403); result = await mcp.handle(value.params); }
          else result = this.#read(value.method, value.params);
          this.#gate(); await peer.send({ id: sequence, ok: true, result: result ?? null });
        } catch (error) {
          // Revalidate even on failure: no source/errors may escape revoked leases.
          try { this.#gate(); } catch { void this.close(); return; }
          const code = error instanceof AppError && publicCodes.has(error.code) ? error.code : "BRIDGE_REQUEST_FAILED";
          await peer.send({ id: sequence, ok: false, code });
        }
      });
      this.#work.add(work);
      try { await work; } finally { this.#work.delete(work); }
    }, () => {
      clearTimeout(authTimer); this.#sockets.delete(socket);
      // An authenticated transport cannot silently reconnect/resume a stale turn.
      if (role && !this.#closing) void this.close();
    });
  }
  #read(method: string, input: unknown): unknown {
    check(Object.hasOwn(maintenanceReadSchemas, method), "TOOL_DENIED", "文件工具不在白名单", 403);
    assertSchema(input, maintenanceReadSchemas[method as keyof typeof maintenanceReadSchemas], "只读文件工具");
    const p = input as { path?: string; pattern?: string; query?: string; offset?: number; limit?: number };
    if (method === "read") return this.#reader.read(p.path!, p.offset, p.limit);
    if (method === "ls") return this.#reader.ls(p.path, p.offset, p.limit);
    if (method === "find") return this.#reader.find(p.pattern, p.offset, p.limit);
    return this.#reader.grep(p.query!, p.offset, p.limit);
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true; this.#removeSignals?.(); if (this.#ttl) clearTimeout(this.#ttl);
      this.#controller.abort(); this.#grant.revoke(); this.#reader.revoke();
      for (const socket of this.#sockets) socket.destroy();
      void (async () => {
        await new Promise<void>(resolve => { if (this.#server.listening) this.#server.close(() => resolve()); else resolve(); });
        while (this.#work.size) await Promise.allSettled([...this.#work]);
        // Socket close events are part of the proof, not merely destroy() calls.
        if (this.#sockets.size) await Promise.all([...this.#sockets].map(socket => new Promise<void>(resolve => socket.once("close", resolve))));
        this.#closed = true; this.#secrets = { reader: "", mcp: "" }; this.#resolve();
      })();
    }
    return this.#done;
  }
  /** Only bridge resources; this is NOT proof the Provider process tree exited. */
  assertClosed(): void { check(this.#closed && !this.#server.listening && !this.#sockets.size && !this.#work.size, "PROCESS_STOP_UNCONFIRMED", "私有工具通道或在途调用尚未退出", 409); }
}
