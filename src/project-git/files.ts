import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";

export const safeId = (id: string) => {
  check(typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id), "PROJECT_INVALID_ID", "项目资源 ID 无效");
  return id;
};
/** All host-managed paths reject existing symlink components, including cleanup paths. */
export class ProjectFiles {
  readonly root: string;
  private readonly identity: { dev: number; ino: number };
  constructor(dataDir: string) { this.root = realpathSync(dataDir); this.identity = lstatSync(this.root); }
  path(...parts: string[]) {
    const root = lstatSync(this.root);
    check(root.isDirectory() && !root.isSymbolicLink() && root.dev === this.identity.dev && root.ino === this.identity.ino, "PROJECT_PATH_INVALID", "数据根目录已变化");
    const base = join(this.root, "project-git"), target = join(base, ...parts), rel = relative(this.root, target), scoped = relative(base, target);
    check(rel && !scoped.startsWith("..") && !isAbsolute(scoped), "PROJECT_PATH_INVALID", "项目资源路径无效");
    let current = this.root;
    for (const part of rel.split(/[\\/]/)) {
      current = join(current, part);
      try { check(!lstatSync(current).isSymbolicLink(), "PROJECT_PATH_INVALID", "项目资源路径不允许符号链接"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return target;
  }
  directory(...parts: string[]) { const path = this.path(...parts); mkdirSync(path, { recursive: true, mode: 0o700 }); return path; }
  read<T>(parts: string[], fallback?: T): T {
    try { return JSON.parse(readFileSync(this.path(...parts), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
  }
  write(parts: string[], value: unknown) {
    const target = this.path(...parts); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); renameSync(temp, target); }
    finally { rmSync(temp, { force: true }); }
  }
  remove(...parts: string[]) { rmSync(this.path(...parts), { recursive: true, force: true }); }
}
