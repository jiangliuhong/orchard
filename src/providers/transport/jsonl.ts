import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AppError } from "../../domain/errors.js";
import type { AgentLimits } from "../agent-limits.js";

export interface JsonlOptions {
  executable: string;
  args: string[];
  cwd: string;
  /** 额外环境变量；继承宿主受控环境（含 CODEX_HOME 等本机配置）。 */
  env?: Record<string, string>;
  /** Internal project lease directory for conservative orphan-process recovery. */
  processDirectory?: string;
  limits: Pick<AgentLimits, "maxProtocolRecordBytes" | "maxBufferedWriteBytes" | "terminateGraceMs">;
  /** stdout 上每条完整协议记录（已解析的 JSON 值）。 */
  onRecord: (record: unknown) => void;
  /** stderr 诊断文本（增量，非协议数据）。 */
  onDiagnostic: (text: string) => void;
  /** 协议流完整性破坏或进程意外退出时触发，最多一次。 */
  onBroken: (error: AppError) => void;
}

/**
 * 常驻子进程的 JSONL 双向协议连接（设计文档 §8）。
 *
 * - stdout 严格按 LF (0x0A) 分割，允许行尾 CR；不把 U+2028/U+2029 当作分隔符。
 *   按字节定位换行、只对完整行解码，天然规避多字节字符被拆开的问题。
 * - stderr 仅作为诊断流转发，不参与协议解析。
 * - stdin 写入维护有界背压队列，超限立即失败。
 * - 进程以独立进程组启动（shell:false、绝对路径），关闭时先 stdin EOF + SIGTERM，
 *   超过 terminateGraceMs 后 SIGKILL 整个进程组。
 */
export class JsonlConnection {
  private readonly child: ChildProcess;
  private readonly decoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private buffer = Buffer.alloc(0);
  private scanned = 0;
  private closing = false;
  private broken = false;
  private exitedResolve!: () => void;
  readonly exited: Promise<void>;

  private readonly writeQueue: Buffer[] = [];
  private writeQueuedBytes = 0;
  private writeClosed = false;
  private drainScheduled = false;
  private writeWaiters: Array<() => void> = [];
  private drainWaiters: Array<() => void> = [];
  private writeError: AppError | undefined;

  private constructor(private readonly options: JsonlOptions) {
    this.exited = new Promise<void>(resolve => { this.exitedResolve = resolve; });
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (options.processDirectory) this.child.once("spawn", () => {
      try { writeFileSync(join(options.processDirectory!, "process.json"), JSON.stringify({ pid: this.child.pid, ownerPid: process.pid, startedAt: Date.now() }), { flag: "wx", mode: 0o600 }); }
      catch { this.fail(new AppError("PROJECT_IO_FAILED", "无法记录项目进程租约")); }
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => {
      try { options.onDiagnostic(this.stderrDecoder.write(chunk)); } catch { /* 诊断回调不得影响协议流 */ }
    });
    this.child.stdin!.on("error", () => { /* EPIPE 按连接关闭处理 */ });
    this.child.stdin!.on("drain", () => { for (const waiter of this.drainWaiters.splice(0)) waiter(); });
    this.child.on("error", error => this.fail(new AppError("PROCESS_START_FAILED", error.message)));
    this.child.on("close", () => {
      const trailing = this.buffer.subarray(this.scanned);
      if (!this.closing && !this.broken) {
        const detail = trailing.length ? "协议流在记录中间结束" : "进程意外退出";
        const stderr = this.stderrDecoder.end();
        this.fail(new AppError("PROCESS_EXITED_UNEXPECTEDLY", `${detail}${stderr ? `: ${stderr.slice(-400)}` : ""}`));
      } else if (trailing.length && !this.broken) {
        this.fail(new AppError("PROCESS_EXITED_UNEXPECTEDLY", "协议流在记录中间结束"));
      }
      this.finishWrites(new AppError("PROCESS_EXITED_UNEXPECTEDLY", "进程已退出，无法继续写入"));
      this.exitedResolve();
    });
  }

  static start(options: JsonlOptions): JsonlConnection {
    return new JsonlConnection(options);
  }

  get pid() { return this.child.pid; }

  /** 写入一行协议记录（不含换行，由本方法追加 LF）。处理背压并执行有界队列限制。 */
  async write(text: string): Promise<void> {
    if (this.writeError) throw this.writeError;
    if (this.writeClosed) throw new AppError("PROTOCOL_STATE_INVALID", "连接已停止写入");
    const record = Buffer.concat([Buffer.from(text, "utf8"), Buffer.from("\n")]);
    if (record.byteLength > this.options.limits.maxProtocolRecordBytes) {
      throw new AppError("OUTPUT_LIMIT", `协议记录超过 ${this.options.limits.maxProtocolRecordBytes} 字节上限`);
    }
    if (this.writeQueuedBytes + record.byteLength > this.options.limits.maxBufferedWriteBytes) {
      throw new AppError("OUTPUT_LIMIT", "写入队列超过背压缓冲上限");
    }
    // 先登记 waiter 再触发 drain，避免 drain 同步完成时丢失通知。
    const flushed = new Promise<void>(resolve => this.writeWaiters.push(resolve));
    this.writeQueue.push(record);
    this.writeQueuedBytes += record.byteLength;
    void this.drain();
    await flushed;
    if (this.writeError) throw this.writeError;
  }

  private async drain(): Promise<void> {
    if (this.drainScheduled || this.writeClosed) return;
    this.drainScheduled = true;
    try {
      while (this.writeQueue.length && !this.writeClosed) {
        const record = this.writeQueue[0]!;
        const ok = this.child.stdin!.write(record);
        this.writeQueue.shift();
        this.writeQueuedBytes -= record.byteLength;
        if (!ok) {
          // 可被 finishWrites 打断，避免进程退出后永久挂在 drain 事件上。
          await new Promise<void>(resolve => this.drainWaiters.push(resolve));
        }
      }
    } catch (error) {
      this.finishWrites(error instanceof AppError ? error : new AppError("PROCESS_EXITED_UNEXPECTEDLY", `协议写入失败: ${error instanceof Error ? error.message : String(error)}`));
    } finally {
      this.drainScheduled = false;
      const pending = this.writeQueue.length > 0 || this.writeQueuedBytes > 0;
      if (!pending) for (const waiter of this.writeWaiters.splice(0)) waiter();
    }
  }

  private finishWrites(error: AppError) {
    if (this.writeError) return;
    this.writeError = error;
    this.writeClosed = true;
    this.writeQueue.length = 0;
    this.writeQueuedBytes = 0;
    for (const waiter of this.drainWaiters.splice(0)) waiter();
    for (const waiter of this.writeWaiters.splice(0)) waiter();
  }

  private onStdout(chunk: Buffer) {
    if (this.broken) return;
    this.buffer = this.scanned === 0 ? Buffer.concat([this.buffer, chunk]) : Buffer.concat([this.buffer.subarray(this.scanned), chunk]);
    this.scanned = 0;
    let index: number;
    while ((index = this.buffer.indexOf(0x0a, this.scanned)) >= 0) {
      let line = this.buffer.subarray(this.scanned, index);
      this.scanned = index + 1;
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) continue; // 空行忽略
      const text = this.decoder.write(line);
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        this.fail(new AppError("PROTOCOL_STATE_INVALID", `协议记录不是合法 JSON: ${text.slice(0, 160)}`));
        return;
      }
      try {
        this.options.onRecord(record);
      } catch (error) {
        this.fail(new AppError("PROTOCOL_STATE_INVALID", `协议记录处理失败: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }
    if (this.buffer.length - this.scanned > this.options.limits.maxProtocolRecordBytes) {
      this.fail(new AppError("OUTPUT_LIMIT", `单条协议记录超过 ${this.options.limits.maxProtocolRecordBytes} 字节`));
    }
  }

  private fail(error: AppError) {
    if (this.broken) return;
    this.broken = true;
    this.killGroup();
    this.options.onBroken(error);
  }

  private killGroup() {
    try {
      if (this.child.pid && process.platform !== "win32") process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch { /* 进程可能已退出 */ }
  }

  /** 主动关闭：请求有序退出（stdin EOF → SIGTERM → 宽限后 SIGKILL），等待进程完全退出。 */
  async close(): Promise<void> {
    if (this.closing) return this.exited;
    this.closing = true;
    this.finishWrites(new AppError("PROCESS_EXITED_UNEXPECTEDLY", "连接已关闭"));
    try { this.child.stdin!.end(); } catch { /* 已断开 */ }
    const timer = setTimeout(() => this.killGroup(), this.options.limits.terminateGraceMs);
    timer.unref();
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}
