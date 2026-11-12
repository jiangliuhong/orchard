import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { AppError, check } from "../domain/errors.js";
import type { MaintenanceProcessBinding } from "./maintenance-sessions.js";
import type { MaintenanceStopJournal } from "./maintenance-stop-journal.js";

export interface MaintenanceProcessLease { readonly signal: AbortSignal }
export interface MaintenanceNodeLaunch {
  /** Internal compiled package entry, NEVER an Agent-provided command/path.
   * The future launcher must attest package identity before calling this API. */
  entry: string; args?: readonly string[]; cwd: string;
  /** Explicit clean environment. No process.env merge or NODE_OPTIONS. */
  env: Readonly<Partial<Record<"PATH" | "HOME" | "TMPDIR" | "PI_CODING_AGENT_DIR" | "PI_OFFLINE" | "LANG" | "TZ", string>>>;
  privatePipes?: number;
}
export interface MaintenanceManagedProcess {
  readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable;
  readonly privatePipes: readonly (Readable & Writable)[];
  /** Native exit event (or a confirmed failure before spawn), NOT a stop proof. */
  readonly exited: Promise<void>;
}
interface ProcessRecord {
  child: ChildProcess; started: boolean; exited: boolean; closed: boolean; groupAbsent: boolean;
}
interface LeaseRecord {
  binding: Readonly<MaintenanceProcessBinding>; controller: AbortController;
  state: "open" | "stopping" | "stopped"; processes: ProcessRecord[];
  work: Set<Promise<unknown>>; stopping?: Promise<void>;
}
const stopError = () => new AppError("PROCESS_STOP_UNCONFIRMED", "受管维护进程或在途回调尚未确认停止", 503);
const environmentKeys = new Set(["PATH", "HOME", "TMPDIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "LANG", "TZ"]);
const sameBinding = (a: MaintenanceProcessBinding, b: MaintenanceProcessBinding) => a.taskId === b.taskId && a.sessionId === b.sessionId && a.generation === b.generation;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Host-only POSIX process registry. Owns actual ChildProcess handles and groups
 * created by this instance; never adopts a PID/file/DB status on restart.
 * This proves ONLY the recorded children/groups and registered callbacks stopped.
 * It does NOT prove escaped/unregistered descendants, grants/readers/IPC, package
 * integrity or project-wide quiescence. Do not wire it alone as assertStopped or
 * assertQuiescent. No Provider is enabled by constructing this registry. */
export class MaintenanceProcessRegistry {
  #leases = new WeakMap<MaintenanceProcessLease, LeaseRecord>();
  #records = new Set<LeaseRecord>(); #closing = false; #close?: Promise<void>;
  constructor(private readonly journal?: MaintenanceStopJournal) {}
  reserve(binding: MaintenanceProcessBinding): MaintenanceProcessLease {
    check(process.platform !== "win32", "MAINTENANCE_PROCESS_PLATFORM_UNSUPPORTED", "此平台尚无已验证的维护进程组实现", 503);
    check(binding && typeof binding.taskId === "string" && binding.taskId.length > 0 && binding.taskId.length <= 200 &&
      typeof binding.sessionId === "string" && binding.sessionId.length > 0 && binding.sessionId.length <= 200 && Number.isSafeInteger(binding.generation) && binding.generation > 0,
    "MAINTENANCE_PROCESS_BINDING_INVALID", "维护进程归属无效");
    check(!this.#closing && this.#records.size < 128 && [...this.#records].every(r => r.state === "stopped" && r.binding.taskId !== binding.taskId), "MAINTENANCE_PROCESS_BUSY", "维护进程仍占用共享执行边界", 409);
    const controller = new AbortController(), lease = Object.freeze({ signal: controller.signal });
    const record: LeaseRecord = { binding: Object.freeze({ taskId: binding.taskId, sessionId: binding.sessionId, generation: binding.generation }), controller, state: "open", processes: [], work: new Set() };
    this.journal?.reserve(record.binding);
    this.#leases.set(lease, record); this.#records.add(record); return lease;
  }
  #record(lease: MaintenanceProcessLease): LeaseRecord {
    const record = this.#leases.get(lease);
    check(record, "MAINTENANCE_PROCESS_CAPABILITY_INVALID", "维护进程宿主能力无效", 403); return record;
  }
  launch(lease: MaintenanceProcessLease, spec: MaintenanceNodeLaunch): MaintenanceManagedProcess {
    const record = this.#record(lease);
    check(!this.#closing && record.state === "open" && record.processes.length < 4, "MAINTENANCE_PROCESS_BUSY", "维护进程已停止准入", 409);
    const args = spec.args ?? [], pipes = spec.privatePipes ?? 0;
    check(isAbsolute(spec.entry) && /\.(?:mjs|cjs|js)$/.test(spec.entry) && isAbsolute(spec.cwd) && !spec.entry.includes("\0") && !spec.cwd.includes("\0") &&
      args.length <= 128 && args.every(arg => typeof arg === "string" && !arg.includes("\0")) && Buffer.byteLength(JSON.stringify(args)) <= 65536 &&
      Number.isSafeInteger(pipes) && pipes >= 0 && pipes <= 3 && spec.env && Object.entries(spec.env).every(([key, value]) => environmentKeys.has(key) && typeof value === "string" && !value.includes("\0") && value.length <= 8192),
    "MAINTENANCE_PROCESS_LAUNCH_INVALID", "维护进程启动参数不符合内部约束");
    const stdio: StdioOptions = ["pipe", "pipe", "pipe", ...Array.from({ length: pipes }, () => "pipe" as const)];
    let child: ChildProcess;
    // Node otherwise copies NODE_V8_COVERAGE even with an explicit env option.
    // An own undefined property suppresses copying without passing it to exec.
    // Null prototype also prevents inherited enumerable environment injection.
    const env: NodeJS.ProcessEnv = Object.assign(Object.create(null), { NODE_V8_COVERAGE: undefined },
      process.platform === "darwin" ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid!().toString(16)}:0x0:0x0` } : {}, spec.env);
    const journalSlot = this.journal?.beforeSpawn(record.binding);
    try { child = spawn(process.execPath, [spec.entry, ...args], { cwd: spec.cwd, env, detached: true, shell: false, stdio }); }
    catch { throw new AppError("MAINTENANCE_PROCESS_START_FAILED", "维护子进程未能启动", 503); }
    // Registration is synchronous and precedes every child event/await.
    const processRecord: ProcessRecord = { child, started: false, exited: false, closed: false, groupAbsent: false };
    record.processes.push(processRecord);
    let resolveExit!: () => void; const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    child.once("spawn", () => {
      processRecord.started = true;
      // Cancellation may precede the asynchronous spawn event (even all signal
      // phases with a zero budget). Do not leave this late child running.
      if (record.state !== "open") this.#signal(record, "SIGTERM");
    });
    child.on("error", () => {
      // Only a pre-spawn failure with no PID proves no child was created. A
      // post-spawn error (e.g. failed signal) must never impersonate exit.
      if (!processRecord.started && child.pid === undefined) { processRecord.exited = true; processRecord.groupAbsent = true; resolveExit(); }
    });
    child.once("exit", () => { processRecord.exited = true; resolveExit(); });
    child.once("close", () => { processRecord.closed = true; });
    for (const stream of child.stdio) stream?.on("error", () => {});
    if (journalSlot !== undefined) this.journal!.afterSpawn(record.binding, journalSlot, child.pid ?? 0);
    return Object.freeze({ stdin: child.stdin!, stdout: child.stdout!, stderr: child.stderr!,
      privatePipes: Object.freeze(child.stdio.slice(3) as (Readable & Writable)[]), exited });
  }
  /** Register protocol callbacks BEFORE invoking them, including rejection paths.
   * A stop cannot finish while any callback remains unresolved. */
  track<T>(lease: MaintenanceProcessLease, operation: () => Promise<T>): Promise<T> {
    const record = this.#record(lease);
    check(!this.#closing && record.state === "open", "MAINTENANCE_PROCESS_BUSY", "维护回调已停止准入", 409);
    const work = Promise.resolve().then(() => { lease.signal.throwIfAborted(); return operation(); });
    record.work.add(work);
    void work.then(() => record.work.delete(work), () => record.work.delete(work)); return work;
  }
  #allStopped(record: LeaseRecord): boolean {
    if (record.work.size) return false;
    return record.processes.every(p => {
      if (!p.exited || !p.closed) return false;
      if (p.groupAbsent) return true;
      if (!p.started || !p.child.pid) return false;
      // Probe ONLY a group minted by our actual detached spawn. No ps scans,
      // arbitrary PIDs, DB inference, or adoption after restart. Latch absence
      // permanently; never signal/probe a previously absent, possibly reused ID.
      try { process.kill(-p.child.pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { p.groupAbsent = true; return true; } return false; }
    });
  }
  #signal(record: LeaseRecord, signal: "SIGTERM" | "SIGKILL") {
    for (const p of record.processes) {
      // Once the leader exits, ownership of a surviving/reused numeric PGID is
      // ambiguous: keep blocking, never guess or kill an unowned process group.
      if (!p.started || p.exited || p.groupAbsent || !p.child.pid) continue;
      try { process.kill(-p.child.pid, signal); } catch { /* A signal is not proof. */ }
    }
  }
  async #wait(record: LeaseRecord, ms: number): Promise<boolean> {
    const until = performance.now() + ms;
    for (;;) {
      if (this.#allStopped(record)) return true;
      const remaining = until - performance.now(); if (remaining <= 0) return false;
      await delay(Math.min(remaining, 10));
    }
  }
  stop(lease: MaintenanceProcessLease, timing: { eofMs?: number; terminateMs?: number; killMs?: number } = {}): Promise<void> {
    return this.#stopRecord(this.#record(lease), timing);
  }
  #stopRecord(record: LeaseRecord, timing: { eofMs?: number; terminateMs?: number; killMs?: number } = {}): Promise<void> {
    if (record.stopping) return record.stopping;
    const eofMs = timing.eofMs ?? 100, terminateMs = timing.terminateMs ?? 200, killMs = timing.killMs ?? 1000;
    check([eofMs, terminateMs, killMs].every(ms => Number.isSafeInteger(ms) && ms >= 0 && ms <= 10000), "MAINTENANCE_PROCESS_LAUNCH_INVALID", "维护进程停止预算无效");
    // Install the shared promise BEFORE abort listeners can reenter stop/close.
    let resolveStop!: () => void, rejectStop!: (error: unknown) => void;
    const work = new Promise<void>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    record.stopping = work;
    void work.catch(() => { if (record.stopping === work) record.stopping = undefined; });
    record.state = "stopping"; record.controller.abort();
    for (const p of record.processes) { try { p.child.stdin?.end(); } catch { /* Still require real exit. */ } }
    void (async () => {
      if (!await this.#wait(record, eofMs)) {
        this.#signal(record, "SIGTERM");
        if (!await this.#wait(record, terminateMs)) {
          this.#signal(record, "SIGKILL");
          if (!await this.#wait(record, killMs)) throw stopError();
        }
      }
      record.state = "stopped";
    })().then(resolveStop, rejectStop);
    return work;
  }
  assertOwnedStopped(lease: MaintenanceProcessLease, binding: MaintenanceProcessBinding): void {
    const record = this.#record(lease);
    check(sameBinding(record.binding, binding) && record.state === "stopped" && this.#allStopped(record), "PROCESS_STOP_UNCONFIRMED", "受管进程停止证据缺失或归属不匹配", 503);
  }
  forget(lease: MaintenanceProcessLease): void {
    const record = this.#record(lease); this.assertOwnedStopped(lease, record.binding);
    this.journal?.remove(record.binding);
    this.#leases.delete(lease); this.#records.delete(record);
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    this.#closing = true;
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    const work = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    this.#close = work;
    void work.catch(() => { if (this.#close === work) this.#close = undefined; });
    void (async () => {
      const results = await Promise.allSettled([...this.#records].map(record => this.#stopRecord(record)));
      if (results.some(result => result.status === "rejected")) throw stopError();
    })().then(resolveClose, rejectClose);
    return work;
  }
}
