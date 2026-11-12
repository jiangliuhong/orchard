import { isAbsolute, relative, resolve, sep } from "node:path";
import { check } from "../domain/errors.js";
import { PROJECTION_LIMITS } from "./workspace-projection.js";
import { canonicalJson, digest } from "../persistence/files.js";

export function workspaceRelative(path: string): string {
  check(typeof path === "string" && path.length > 0 && path.length <= 500 && !path.includes("\\") && !isAbsolute(path) && path.split("/").every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== ".."),
    "WORKSPACE_PATH_DENIED", "工作区路径无效或越界", 403);
  return path;
}
export function validateWorkspaceFiles(files: Readonly<Record<string, string>>): void {
  check(Object.keys(files).length <= PROJECTION_LIMITS.files, "PROJECTION_TOO_LARGE", "工作区文件数量超限");
  const names = new Set<string>(), directories = new Set<string>(); let bytes = 0;
  for (const [path, content] of Object.entries(files)) {
    workspaceRelative(path);
    const name = path.toLowerCase(), parts = name.split("/"); parts.pop();
    const parents = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    check(!names.has(name) && !directories.has(name) && parents.every(parent => !names.has(parent)), "PROJECTION_COLLISION", "工作区文件路径冲突");
    names.add(name); parents.forEach(parent => directories.add(parent));
    check(typeof content === "string" && Buffer.byteLength(content) <= PROJECTION_LIMITS.fileBytes, "PROJECTION_TOO_LARGE", "工作区文件超限");
    bytes += Buffer.byteLength(content);
  }
  check(bytes <= PROJECTION_LIMITS.totalBytes, "PROJECTION_TOO_LARGE", "工作区总字节数超限");
}

/** Only a verified immutable snapshot, not general host filesystem access. Native
 * read wrappers can use readBuffer; grep/find/ls must use these bounded methods,
 * never spawn a shell or traverse host paths. Every method is revoked on release. */
export class ScopedWorkspaceReader {
  private alive = true;
  private readonly cancellation = new AbortController();
  private readonly hash: string;
  private readonly files: Readonly<Record<string, string>>;
  constructor(readonly cwd: string, files: Readonly<Record<string, string>>) {
    validateWorkspaceFiles(files); this.files = Object.freeze({ ...files }); this.hash = digest(canonicalJson(this.files));
  }
  get signal(): AbortSignal { return this.cancellation.signal; }
  assertIdentity(hash: string): void {
    check(this.alive && this.hash === hash, "WORKSPACE_LEASE_EXPIRED", "工作区读取租约或快照已失效", 403);
  }
  revoke(): void { this.alive = false; this.cancellation.abort(); }
  private path(input: string): string {
    check(this.alive, "WORKSPACE_LEASE_EXPIRED", "工作区读取租约已释放", 403);
    check(typeof input === "string" && !input.includes("\\"), "WORKSPACE_PATH_DENIED", "路径无效", 403);
    let path = input;
    if (isAbsolute(path)) {
      const absolute = resolve(path);
      check(absolute.startsWith(this.cwd + sep), "WORKSPACE_PATH_DENIED", "禁止读取工作区之外的文件", 403);
      path = relative(this.cwd, absolute).split(sep).join("/");
    }
    return workspaceRelative(path);
  }
  readBuffer(input: string): Buffer {
    const path = this.path(input); check(Object.hasOwn(this.files, path), "NOT_FOUND", "工作区文件不存在", 404);
    return Buffer.from(this.files[path]!, "utf8");
  }
  /** Structural ReadOperations for Pi. Override EVERY filesystem operation;
   * omitting the MIME/stream hooks could reintroduce native host filesystem I/O. */
  nativeReadOperations() {
    return {
      readFile: async (path: string) => this.readBuffer(path),
      access: async (path: string) => { this.readBuffer(path); },
      detectImageMimeType: async (path: string) => { this.readBuffer(path); return null; },
      createReadStream: (path: string, options: { signal?: AbortSignal } = {}) => {
        const reader = this;
        return (async function* () {
          const buffer = reader.readBuffer(path);
          for (let offset = 0; offset < buffer.length; offset += 65536) {
            options.signal?.throwIfAborted(); reader.path(path);
            yield buffer.subarray(offset, offset + 65536);
          }
        })();
      },
    };
  }
  read(input: string, offset = 1, limit = 200) {
    const path = this.path(input);
    check(Number.isSafeInteger(offset) && offset >= 1 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, "INVALID_REQUEST", "读取范围无效");
    const lines = this.readBuffer(path).toString("utf8").split("\n");
    const result: string[] = []; let bytes = 0;
    for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
      const size = Buffer.byteLength(line) + 1;
      check(size <= 65536, "WORKSPACE_LINE_TOO_LARGE", "源码单行超出安全返回预算");
      if (bytes + size > 65536) break;
      result.push(line); bytes += size;
    }
    const nextLine = offset - 1 + result.length < lines.length ? offset + result.length : null;
    return { path, startLine: offset, content: result.join("\n"), nextLine, totalLines: lines.length };
  }
  find(pattern = "*", offset = 0, limit = 50) {
    check(this.alive, "WORKSPACE_LEASE_EXPIRED", "工作区读取租约已释放", 403);
    check(typeof pattern === "string" && pattern.length <= 200 && !pattern.includes("\\") && !pattern.startsWith("/") && !pattern.split("/").some(part => part === ".."), "WORKSPACE_PATH_DENIED", "文件匹配范围无效", 403);
    this.page(offset, limit);
    // Linear-space glob matching, no model-supplied regex/backtracking engine.
    const matchesPattern = (path: string) => {
      let p = 0, s = 0, star = -1, retry = 0;
      while (s < path.length) {
        if (pattern[p] === "?" || pattern[p] === path[s]) { p++; s++; }
        else if (pattern[p] === "*") { star = p++; retry = s; }
        else if (star >= 0) { p = star + 1; s = ++retry; }
        else return false;
      }
      while (pattern[p] === "*") p++;
      return p === pattern.length;
    };
    const matches = Object.keys(this.files).sort().filter(matchesPattern);
    return { items: matches.slice(offset, offset + limit), nextOffset: offset + limit < matches.length ? offset + limit : null };
  }
  ls(input = ".", offset = 0, limit = 50) {
    check(this.alive, "WORKSPACE_LEASE_EXPIRED", "工作区读取租约已释放", 403); this.page(offset, limit);
    const prefix = input === "." || input === this.cwd ? "" : `${this.path(input)}/`;
    const names = new Map<string, boolean>();
    for (const path of Object.keys(this.files)) if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length), slash = rest.indexOf("/"); names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
    }
    const items = [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, directory]) => ({ name, directory }));
    return { items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
  }
  grep(query: string, offset = 0, limit = 50) {
    check(this.alive, "WORKSPACE_LEASE_EXPIRED", "工作区读取租约已释放", 403); this.page(offset, limit);
    check(typeof query === "string" && query.length > 0 && query.length <= 200, "INVALID_REQUEST", "搜索文本无效");
    const items: { path: string; line: number; text: string }[] = []; let seen = 0, bytes = 0, more = false;
    outer: for (const path of Object.keys(this.files).sort()) {
      const lines = this.files[path]!.split("\n");
      for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(query)) {
        if (seen++ < offset) continue;
        const text = lines[i]!, size = Buffer.byteLength(text);
        check(size <= 65536, "WORKSPACE_LINE_TOO_LARGE", "匹配行超出安全返回预算");
        if (items.length === limit || bytes + size > 65536) { more = true; break outer; }
        items.push({ path, line: i + 1, text }); bytes += size;
      }
    }
    return { items, nextOffset: more ? offset + items.length : null };
  }
  private page(offset: number, limit: number) { check(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 50, "INVALID_REQUEST", "分页范围无效"); }
}
