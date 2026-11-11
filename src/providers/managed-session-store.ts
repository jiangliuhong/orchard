import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { check } from "../domain/errors.js";

const MARKER = ".orchard-session-store.json";
interface StoreMarker { formatVersion: 1; providerId: string; storeId: string }

/** Provider 私有存储身份，不属于公开 DTO 或通用会话文件格式。
 * 初始化只允许空的、已创建的平台私有目录；绝不收编用户现有 CLI home。
 * 生产初始化须在现有数据目录单写者租约内调用。
 */
export class ManagedSessionStore {
  readonly id: string;
  private readonly identity: { dev: number; ino: number };
  private constructor(readonly root: string, readonly providerId: string) {
    this.checkRoot();
    this.identity = lstatSync(root);
    this.id = this.marker().storeId;
  }

  private checkRoot(): void {
    check(isAbsolute(this.root) && resolve(this.root) === this.root && dirname(this.root) !== this.root && realpathSync(this.root) === this.root,
      "BACKEND_STORAGE_UNAVAILABLE", "原生受管存储路径无效或包含符号链接");
    check(lstatSync(this.root).isDirectory(), "BACKEND_STORAGE_UNAVAILABLE", "原生受管存储根不是目录");
  }

  private marker(): StoreMarker {
    const fd = openSync(join(this.root, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      check(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 4096, "BACKEND_STORAGE_UNAVAILABLE", "原生存储身份记录无效");
      const buffer = Buffer.alloc(4097);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      check(size === info.size, "BACKEND_STORAGE_UNAVAILABLE", "原生存储身份记录在读取时变化");
      let value: StoreMarker;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
      catch { throw new Error("原生存储身份记录无法解码"); }
      check(value !== null && Object.keys(value).length === 3 && value.formatVersion === 1 && value.providerId === this.providerId && typeof value.storeId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.storeId),
        "BACKEND_STORAGE_UNAVAILABLE", "原生存储身份或 Provider 不匹配");
      return value;
    } finally { closeSync(fd); }
  }

  static open(root: string, providerId: string): ManagedSessionStore { return new ManagedSessionStore(root, providerId); }

  static initialize(root: string, providerId: string): ManagedSessionStore {
    check(providerId.length > 0 && providerId.length <= 200, "BACKEND_STORAGE_UNAVAILABLE", "Provider 身份无效");
    check(isAbsolute(root) && resolve(root) === root && dirname(root) !== root && realpathSync(root) === root && lstatSync(root).isDirectory(),
      "BACKEND_STORAGE_UNAVAILABLE", "原生受管存储路径无效");
    const entries = readdirSync(root);
    if (entries.includes(MARKER)) return this.open(root, providerId);
    check(entries.length === 0, "BACKEND_STORAGE_UNAVAILABLE", "不能自动接管已有文件的未知原生存储");
    const fd = openSync(join(root, MARKER), "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ formatVersion: 1, providerId, storeId: randomUUID() } satisfies StoreMarker));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return this.open(root, providerId);
  }

  /** storeId 存入 Provider 不透明引用；服务重启也不会把新建空目录误当原会话已删除。 */
  assert(expectedStoreId = this.id): void {
    this.checkRoot();
    const root = lstatSync(this.root);
    check(root.dev === this.identity.dev && root.ino === this.identity.ino && expectedStoreId === this.id && this.marker().storeId === expectedStoreId,
      "BACKEND_STORAGE_UNAVAILABLE", "原生受管存储身份已变化，不能报告目标不存在");
  }
}
