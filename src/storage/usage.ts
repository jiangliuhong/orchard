import { lstat, opendir, realpath, statfs } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { AppError, check } from "../domain/errors.js";
import { configCoordinator } from "../config-git/coordinator.js";
import type { Store } from "../persistence/store.js";
import { gitProjects } from "../project-git/service.js";

export interface UsageSize { incomplete?: boolean; allocatedBytes: string | null; logicalBytes: string; fileCount: string }
export interface StorageUsage extends UsageSize {
  dataDir: string; scanId: string; startedAt: number; completedAt: number;
  categories: (UsageSize & { id: string; name: string })[];
  projects: (UsageSize & { id: string; name: string; cacheBytes: string | null; temporaryBytes: string | null; activeLease: boolean })[];
  filesystem: { totalBytes: string; availableBytes: string; sampledAt: number } | null;
  partial: boolean; reasons: Record<string, number>; excluded: number;
}
export interface StorageScan { scanId: string; status: "scanning" | "completed" | "partial" | "failed"; result: StorageUsage | null; error?: string }
const categories = {
  database: "数据库（含 WAL/SHM）", definitions: "工作流/脚本定义与产物", runs: "运行资料", agents: "Agent 工作区与会话",
  configGit: "配置 Git 仓库与恢复资料", projectCache: "项目 Git 缓存", projectTemporary: "项目快照与临时文件", localConfig: "密钥与本机配置", other: "其他",
};
export function usageCategory(path: string): keyof typeof categories {
  if (/^workbench\.db(?:-(?:wal|shm|journal))?$/.test(path)) return "database";
  if (/^project-git\/cache(?:\/|$)/.test(path)) return "projectCache";
  if (/^project-git\/(?:staging|workspaces|sessions|leases|runs)(?:\/|$)/.test(path)) return "projectTemporary";
  if (/^project-git(?:\/|$)/.test(path)) return "localConfig";
  if (/^(?:artifacts)(?:\/|$)/.test(path)) return "definitions";
  if (/^runs(?:\/|$)/.test(path)) return "runs";
  if (/^(?:agent-workspaces|agent-sessions|script-agent)(?:\/|$)/.test(path)) return "agents";
  if (/^(?:config-git|config\/git)(?:\/|$)/.test(path)) return "configGit";
  if (path === "runtime/api-token" || /^(?:config|secrets)(?:\/|$)/.test(path)) return "localConfig";
  return "other";
}
interface Counter { allocated: bigint; logical: bigint; files: bigint }
const counter = (): Counter => ({ allocated: 0n, logical: 0n, files: 0n });
export class StorageUsageService {
  private latest: StorageUsage | null = null;
  private scan: StorageScan | null = null;
  private job?: Promise<void>;
  private controller?: AbortController;
  private closed = false;
  readonly root: string;
  constructor(readonly store: Store) { this.root = realpathSync(store.root); gitProjects(store); }
  view() { return { status: this.scan?.status ?? "idle", scanId: this.scan?.scanId ?? null, result: this.latest, error: this.scan?.error }; }
  get(id: string) { check(this.scan?.scanId === id, "NOT_FOUND", "存储扫描记录已过期"); return this.scan; }
  start() {
    configCoordinator(this.store).assertAvailable();
    check(!this.closed, "SERVICE_NOT_READY", "存储统计服务已关闭");
    if (this.scan?.status === "scanning") return this.scan;
    const scan: StorageScan = { scanId: randomUUID(), status: "scanning", result: null };
    this.scan = scan; this.controller = new AbortController();
    this.job = this.collect(scan, this.controller.signal).catch(() => { scan.status = "failed"; scan.error = "存储统计失败，旧结果已过期"; });
    return scan;
  }
  async wait() { await this.job; return this.view(); }
  async close() { this.closed = true; this.controller?.abort(); await this.job; }
  private async collect(scan: StorageScan, signal: AbortSignal) {
    const startedAt = Date.now(), generation = configCoordinator(this.store).generation;
    const totals = counter(), groups = new Map(Object.keys(categories).map(id => [id, counter()]));
    const projects = new Map<string, { value: Counter; cache: bigint; temporary: bigint; activeLease: boolean }>();
    const metadata = gitProjects(this.store).storageMetadata(), names = metadata.names;
    const reasons: Record<string, number> = {}, seen = new Set<string>();
    let allocatedSupported = true, excluded = 0, steps = 0;
    const reason = (id: string) => { reasons[id] = (reasons[id] ?? 0) + 1; };
    const rootInfo = await lstat(this.root, { bigint: true });
    const add = (path: string, info: Awaited<ReturnType<typeof lstat>> & { size: bigint; blocks: bigint; dev: bigint; ino: bigint }) => {
      const key = `${info.dev}:${info.ino}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (typeof info.blocks !== "bigint" || info.blocks < 0n) allocatedSupported = false;
      const allocated = typeof info.blocks === "bigint" && info.blocks >= 0n ? info.blocks * 512n : 0n;
      const logical = info.isFile() ? info.size : 0n, files = info.isFile() ? 1n : 0n;
      const category = usageCategory(path);
      const counts = [totals, groups.get(category)!];
      const match = /^project-git\/cache\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,199})(\/|$)/.exec(path);
      let projectId = match && (match[2] || info.isDirectory()) ? match[1] : undefined;
      if (!projectId) for (const [prefix, owner] of metadata.owners) if (path === prefix || path.startsWith(`${prefix}/`)) { projectId = owner; break; }
      if (!projectId && (category === "projectCache" || category === "projectTemporary")) projectId = "__shared__";
      if (projectId) {
        let project = projects.get(projectId);
        if (!project) { project = { value: counter(), cache: 0n, temporary: 0n, activeLease: metadata.activeProjects.has(projectId) }; projects.set(projectId, project); }
        counts.push(project.value);
        if (category === "projectCache") project.cache += allocated; else project.temporary += allocated;
      }
      for (const count of counts) { count.allocated += allocated; count.logical += logical; count.files += files; }
    };
    const stack: { path: string; expectedDev: bigint; expectedIno: bigint }[] = [{ path: this.root, expectedDev: rootInfo.dev, expectedIno: rootInfo.ino }];
    while (stack.length) {
      if (signal.aborted || Date.now() - startedAt > 300000) { reason(signal.aborted ? "cancelled" : "timeout"); break; }
      try { configCoordinator(this.store).assertAvailable(); } catch { reason("maintenance"); break; }
      if (configCoordinator(this.store).generation !== generation) { reason("configurationChanged"); break; }
      const item = stack.pop()!;
      const rel = relative(this.root, item.path).split("\\").join("/");
      try {
        const actual = await realpath(item.path);
        const inside = relative(this.root, actual);
        if (inside.startsWith("..") || isAbsolute(inside) || actual !== item.path) { reason("pathChanged"); continue; }
        const info = await lstat(item.path, { bigint: true });
        if (!info.isDirectory() || info.dev !== item.expectedDev || info.ino !== item.expectedIno) { reason("pathChanged"); continue; }
        const entries = await opendir(item.path);
        const children: string[] = [];
        for await (const entry of entries) {
          children.push(entry.name);
          if (signal.aborted || Date.now() - startedAt > 300000) { reason(signal.aborted ? "cancelled" : "timeout"); break; }
          if (++steps % 100 === 0) await setImmediate();
        }
        const after = await lstat(item.path, { bigint: true });
        if (after.ino !== info.ino || after.dev !== info.dev || after.isSymbolicLink()) { reason("pathChanged"); continue; }
        add(rel, info as Parameters<typeof add>[1]);
        // Reverse push ensures stable lexicographic depth-first traversal for hard-link ownership.
        const directories: typeof stack = [];
        for (const name of children.sort()) {
          if (signal.aborted || Date.now() - startedAt > 300000) { reason(signal.aborted ? "cancelled" : "timeout"); break; }
          const child = join(item.path, name), path = relative(this.root, child).split("\\").join("/");
          try {
            if (await realpath(item.path) !== item.path) { reason("pathChanged"); break; }
            const stat = await lstat(child, { bigint: true });
            if (stat.isDirectory() && stat.dev !== rootInfo.dev) { excluded++; reason("crossDevice"); continue; }
            if (stat.isDirectory()) directories.push({ path: child, expectedDev: stat.dev, expectedIno: stat.ino });
            else add(path, stat as Parameters<typeof add>[1]);
          } catch { reason("unreadableOrDisappeared"); }
          if (++steps % 100 === 0) await setImmediate();
        }
        stack.push(...directories.reverse());
      } catch { reason("unreadableOrDisappeared"); }
      await setImmediate();
    }
    let filesystem: StorageUsage["filesystem"] = null;
    try {
      const current = await lstat(this.root, { bigint: true });
      if (!current.isDirectory() || current.ino !== rootInfo.ino || current.dev !== rootInfo.dev || await realpath(this.root) !== this.root) throw new AppError("STORAGE_PATH_CHANGED", "数据目录已变化");
      const fs = await statfs(this.root, { bigint: true }); filesystem = { totalBytes: String(fs.blocks * fs.bsize), availableBytes: String(fs.bavail * fs.bsize), sampledAt: Date.now() }; }
    catch { reason("filesystemUnavailable"); }
    try { configCoordinator(this.store).assertAvailable(); } catch { reason("maintenance"); }
    if (configCoordinator(this.store).generation !== generation) reason("configurationChanged");
    const size = (value: Counter): UsageSize => ({ incomplete: Object.keys(reasons).length > 0, allocatedBytes: allocatedSupported ? String(value.allocated) : null, logicalBytes: String(value.logical), fileCount: String(value.files) });
    const result: StorageUsage = { ...size(totals), dataDir: this.root, scanId: scan.scanId, startedAt, completedAt: Date.now(), partial: Object.keys(reasons).length > 0, reasons, excluded, filesystem,
      categories: [...groups].map(([id, value]) => ({ id, name: categories[id as keyof typeof categories], ...size(value) })),
      projects: [...projects].map(([id, p]) => ({ id, name: id === "__shared__" ? "共享目录元数据 / 未归属临时资源" : names.get(id) ?? id, ...size(p.value), cacheBytes: allocatedSupported ? String(p.cache) : null, temporaryBytes: allocatedSupported ? String(p.temporary) : null, activeLease: p.activeLease })),
    };
    if (reasons.maintenance || reasons.configurationChanged) { scan.status = "failed"; scan.error = "统计期间配置或维护状态变化，结果已作废，请刷新"; return; }
    scan.result = result; scan.status = result.partial ? "partial" : "completed"; this.latest = result;
  }
}
