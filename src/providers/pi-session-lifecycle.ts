import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { validateSessionReference, type DeleteResult, type NativeSessionState, type ProviderSessionLifecycle, type ProviderSessionReference, type SessionLifecycleGuard } from "../agent/provider-contract.js";

import { ManagedSessionStore } from "./managed-session-store.js";

interface PiReferencePayload { file: string; sessionId: string; cwd: string; storeId: string }

/** P0 独立适配器，尚未接入旧 PiRpcProvider。
 * managedRoot 必须由平台分配、预先创建且仅平台可写；不从 cwd 推导，不处理用户 home。
 * 仅支持已核实的 v3 JSONL 单文件引用。伴随资源尚未核实的会话不得注册到此适配器。
 */
export class PiSessionLifecycle implements ProviderSessionLifecycle {
  private readonly storage: ManagedSessionStore;

  constructor(private readonly managedRoot: string, private readonly guard: SessionLifecycleGuard, private readonly providerId = "pi-cli") {
    check(isAbsolute(managedRoot) && resolve(managedRoot) === managedRoot && dirname(managedRoot) !== managedRoot,
      "BACKEND_REFERENCE_INVALID", "Pi 受管存储根必须是规范绝对路径，不能是文件系统根");
    this.checkDirectories(managedRoot);
    this.storage = ManagedSessionStore.open(managedRoot, providerId);
  }

  private checkDirectories(directory: string): void {
    let current = parse(directory).root;
    for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = lstatSync(current);
      check(info.isDirectory() && !info.isSymbolicLink(), "BACKEND_REFERENCE_INVALID", "Pi 存储路径包含符号链接或非目录");
    }
  }

  private payload(reference: ProviderSessionReference): PiReferencePayload {
    const validated = validateSessionReference(reference, {
      providerId: this.providerId, supportedVersions: [1],
      validatePayload: value => {
        check(value !== null && typeof value === "object" && !Array.isArray(value), "BACKEND_REFERENCE_INVALID", "Pi 引用 payload 无效");
        check(Object.keys(value).length === 4 && typeof value.file === "string" && typeof value.sessionId === "string" && typeof value.cwd === "string",
          "BACKEND_REFERENCE_INVALID", "Pi 引用字段无效");
        check(value.sessionId.length > 0 && isAbsolute(value.cwd), "BACKEND_REFERENCE_INVALID", "Pi 引用身份无效");
        check(typeof value.storeId === "string", "BACKEND_REFERENCE_INVALID", "Pi 存储身份缺失");
        this.storage.assert(value.storeId);
      },
    });
    const payload = validated.opaque as unknown as PiReferencePayload;
    const file = resolve(this.managedRoot, payload.file);
    const within = relative(this.managedRoot, file);
    check(payload.file === within && within.length > 0 && !within.startsWith(`..${sep}`) && within !== ".." && !isAbsolute(within) && file.endsWith(".jsonl"),
      "BACKEND_REFERENCE_INVALID", "Pi 会话路径必须是受管范围内的规范相对 JSONL 路径");
    return payload;
  }

  /** 只有父目录可访问且根身份未变时，叶文件 ENOENT 才表示明确不存在。 */
  private target(payload: PiReferencePayload): string {
    this.checkDirectories(this.managedRoot);
    this.storage.assert(payload.storeId);
    const file = join(this.managedRoot, payload.file);
    this.checkDirectories(dirname(file));
    return file;
  }

  private verify(file: string, payload: PiReferencePayload): boolean {
    let info;
    try { info = lstatSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "BACKEND_REFERENCE_INVALID", "Pi 会话必须是无符号链接/硬链接的常规文件");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      check(opened.dev === info.dev && opened.ino === info.ino, "BACKEND_REFERENCE_INVALID", "Pi 会话文件身份在读取时发生变化");
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = readSync(fd, buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, bytes).indexOf(10);
      check(newline >= 0, "BACKEND_REFERENCE_INVALID", "Pi 会话缺少有界完整 header");
      let header: { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
      try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline))); }
      catch { throw new AppError("BACKEND_REFERENCE_INVALID", "Pi 会话 header 无效"); }
      check(header !== null && header.type === "session" && header.version === 3 && header.id === payload.sessionId && header.cwd === payload.cwd,
        "BACKEND_REFERENCE_INVALID", "Pi 会话身份或格式与引用不匹配");
      const latest = lstatSync(file);
      check(latest.dev === opened.dev && latest.ino === opened.ino && !latest.isSymbolicLink(), "BACKEND_REFERENCE_INVALID", "Pi 会话文件在校验时发生变化");
      return true;
    } finally { closeSync(fd); }
  }

  async inspect(reference: ProviderSessionReference, signal: AbortSignal): Promise<NativeSessionState> {
    signal.throwIfAborted();
    try {
      const payload = this.payload(reference);
      return { status: this.verify(this.target(payload), payload) ? "present" : "absent" };
    }
    catch (error) {
      if (error instanceof AppError && ["BACKEND_REFERENCE_INVALID", "BACKEND_PROVIDER_MISMATCH", "BACKEND_REFERENCE_VERSION_UNSUPPORTED"].includes(error.code)) throw error;
      return { status: "unknown", reason: "Pi 受管存储不可访问或身份已变化" };
    }
  }

  async deleteSession(reference: ProviderSessionReference, signal: AbortSignal): Promise<DeleteResult> {
    this.payload(reference);
    signal.throwIfAborted();
    return this.guard.withStoppedSession(reference, signal, async () => {
      signal.throwIfAborted();
      const payload = this.payload(reference);
      const file = this.target(payload);
      if (!this.verify(file, payload)) return { status: "already_absent" };
      // 私有存储 + 宿主独占会话锁保证校验至 unlink 期间无受管写入者；不是恶意本机进程沙箱。
      unlinkSync(file);
      return { status: "deleted" };
    });
  }
}
