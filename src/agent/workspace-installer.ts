import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { configCoordinator } from "../config-git/coordinator.js";
import { durable, safe, syncDirectory } from "../migrations/journal.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { projectionState, requireWorkspaceSchema } from "./workspace-state.js";
import { ScopedWorkspaceReader, validateWorkspaceFiles, workspaceRelative } from "./workspace-files.js";
import type { WorkspaceProjection } from "./workspace-projection.js";

const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
const leases = new WeakMap<Store, { active: boolean }>();
interface Tree { files: Record<string, string>; entries: { path: string; directory: boolean; mode: number }[] }

/** Platform-only one-way installer. No JSON state becomes a second authority.
 * Crash orphans are retained, never guessed/deleted by directory-name scanning;
 * startup repairs by rebuilding the CURRENT DB snapshot after proven quiescence.
 * Existing unowned workspaces require the separate migration/backup procedure.
 */
export class WorkspaceInstaller {
  readonly cwd: string;
  private readonly rules: Readonly<Record<string, string>>;
  private readonly shared: { active: boolean };
  constructor(private readonly store: Store, private readonly options: {
    /** Already verified installation-package files; never an API/source directory. */
    rules: Readonly<Record<string, string>>; knowledgeHash: string;
    source(signal: AbortSignal): Promise<WorkspaceProjection>;
    assertQuiescent(): void;
    /** Internal fault boundary for tests, not an API input. */
    onBoundary?(phase: "staged" | "displaced" | "activated" | "synced"): void;
  }) {
    requireWorkspaceSchema(store); store.directoryLease.assert();
    this.options = Object.freeze({ ...options });
    this.cwd = safe(store.root, "agent/workspace");
    this.rules = Object.freeze({ ...options.rules }); validateWorkspaceFiles(this.rules);
    check(Object.hasOwn(this.rules, "AGENTS.md") && Object.keys(this.rules).every(path => path === "AGENTS.md" || path.startsWith("docs/") || path.startsWith(".agents/skills/")), "WORKSPACE_RULES_INVALID", "内置规则集合含未授权路径");
    let shared = leases.get(store); if (!shared) { shared = { active: false }; leases.set(store, shared); } this.shared = shared;
  }
  private quiescent() { check(this.options.assertQuiescent() === undefined, "PROCESS_STOP_UNCONFIRMED", "维护进程退出未确认", 409); }
  private tree(root: string): Tree {
    const files: Record<string, string> = Object.create(null), entries: Tree["entries"] = []; let bytes = 0;
    const visit = (path: string, depth: number) => {
      const info = lstatSync(path);
      check(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()) && (info.isDirectory() || info.nlink === 1), "WORKSPACE_PATH_DENIED", "工作区含链接或非常规文件", 503);
      check(depth <= 24 && entries.length < 30000, "PROJECTION_TOO_LARGE", "工作区目录超过安全预算");
      entries.push({ path, directory: info.isDirectory(), mode: info.mode & 0o777 });
      if (info.isDirectory()) {
        const handle = opendirSync(path);
        try { for (let entry = handle.readSync(); entry; entry = handle.readSync()) visit(join(path, entry.name), depth + 1); }
        finally { handle.closeSync(); }
      } else {
        const name = workspaceRelative(relative(root, path));
        check(info.size <= 1024 * 1024 && bytes + info.size <= 32 * 1024 * 1024, "PROJECTION_TOO_LARGE", "工作区文件超过预算");
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          check(opened.ino === info.ino && opened.dev === info.dev && opened.isFile() && opened.nlink === 1 && opened.size === info.size, "WORKSPACE_PATH_DENIED", "工作区读取期间文件身份变化", 503);
          const content = readFileSync(fd);
          check(content.length <= 1024 * 1024, "PROJECTION_TOO_LARGE", "工作区文件超限");
          files[name] = content.toString("utf8"); bytes += content.length;
        } finally { closeSync(fd); }
      }
    };
    visit(root, 0); validateWorkspaceFiles(files); return { files, entries };
  }
  private removeAllocated(root: string, inode: number): void {
    if (!exists(root)) return;
    check(lstatSync(root).ino === inode, "WORKSPACE_PATH_DENIED", "暂存目录身份变化，保留以供诊断", 503);
    const tree = this.tree(root); // Validate the entire tree before the first deletion.
    for (const entry of tree.entries) if (entry.directory) chmodSync(entry.path, 0o700);
    for (const entry of tree.entries.reverse()) if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
    syncDirectory(dirname(root));
  }
  private move(source: string, target: string) {
    check(!exists(target), "WORKSPACE_PATH_DENIED", "工作区切换目标已存在", 503);
    const info = lstatSync(source);
    check(info.isDirectory() && !info.isSymbolicLink(), "WORKSPACE_PATH_DENIED", "工作区切换源不是受管目录", 503);
    const mode = info.mode & 0o777;
    let moved = false;
    try { chmodSync(source, 0o700); renameSync(source, target); moved = true; }
    finally { chmodSync(moved ? target : source, mode); }
    syncDirectory(dirname(source)); syncDirectory(dirname(target));
  }
  private allocatedOwner(): boolean {
    const journal = safe(this.store.root, "agent/tmp/workspace-allocation.json");
    if (!exists(journal) || !exists(this.cwd)) return false;
    const info = lstatSync(journal);
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1024, "WORKSPACE_JOURNAL_INVALID", "工作区归属日志无效", 503);
    let id: unknown;
    try { const value = JSON.parse(readFileSync(journal, "utf8")); id = Object.keys(value).length === 1 ? value.id : undefined; } catch { /* Reject below. */ }
    check(typeof id === "string" && /^[a-f0-9-]{36}$/.test(id), "WORKSPACE_JOURNAL_INVALID", "工作区归属日志标识无效", 503);
    const receipt = this.store.one<{ request_hash: string; result_json: string }>("SELECT request_hash,result_json FROM command_receipts WHERE scope='workspace.install' AND request_id=?", id);
    check(receipt && digest(receipt.result_json) === receipt.request_hash, "WORKSPACE_JOURNAL_INVALID", "工作区归属日志没有匹配的数据库登记", 503);
    const allocation = JSON.parse(receipt.result_json) as { inode: number; hash: string; generation: number };
    return allocation.inode === lstatSync(this.cwd).ino && allocation.generation <= projectionState(this.store).target_generation && digest(canonicalJson(this.tree(this.cwd).files)) === allocation.hash;
  }
  private matches(files: Readonly<Record<string, string>>): boolean {
    if (!exists(this.cwd)) return false;
    const tree = this.tree(this.cwd);
    return canonicalJson(tree.files) === canonicalJson(files) && tree.entries.every(entry => entry.mode === (entry.directory ? 0o555 : 0o444));
  }

  async synchronize(signal: AbortSignal): Promise<{ generation: number; hash: string; changed: boolean }> {
    signal.throwIfAborted(); this.store.directoryLease.assert(); this.quiescent();
    check(!this.shared.active && !this.store.one("SELECT id FROM agent_maintenance_tasks WHERE status IN ('queued','running','stopping') LIMIT 1"), "WORKSPACE_BUSY", "维护任务仍在读取工作区", 409);
    const start = projectionState(this.store);
    check(start.target_knowledge_hash === this.options.knowledgeHash, "WORKSPACE_RULES_OUTDATED", "安装包规则与目标版本不匹配", 503);
    const business = await this.options.source(signal); signal.throwIfAborted();
    check(digest(canonicalJson(business.files)) === business.hash, "PROJECTION_HASH_INVALID", "业务投影摘要无效", 503);
    check(Object.keys(business.files).every(path => path === "project.json" || /^(workflows|scripts|browser-tools)\//.test(path)), "WORKSPACE_PATH_DENIED", "业务投影包含受保护路径", 503);
    const files = Object.freeze({ ...this.rules, ...business.files }); validateWorkspaceFiles(files);
    const hash = digest(canonicalJson(files));
    return configCoordinator(this.store).withWrite(async () => {
      this.quiescent(); this.store.directoryLease.assert();
      check(!this.shared.active && projectionState(this.store).target_generation === start.target_generation, "REVISION_CONFLICT", "投影源在生成期间变化", 409);
      const temporary = safe(this.store.root, "agent/tmp");
      for (const path of [safe(this.store.root, "agent"), temporary]) if (!exists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
      safe(this.store.root, "agent/workspace");
      let stage: string | undefined, stageInode = 0, previous: string | undefined, previousInode = 0, committed = false;
      try {
        this.store.exec("UPDATE agent_workspace_projection_state SET state='syncing',error_code=NULL,updated_at=? WHERE id='maintenance' AND target_generation=?", Date.now(), start.target_generation);
        check(!exists(this.cwd) || (start.synced_generation > 0 && start.content_hash !== null) || this.allocatedOwner(), "WORKSPACE_UNOWNED", "现有工作区没有投影持久归属，须独立备份迁移", 503);
        const changed = !this.matches(files);
        if (changed) {
          if (exists(this.cwd)) this.tree(this.cwd);
          const id = randomUUID(); stage = safe(this.store.root, `agent/tmp/projection-${id}`);
          mkdirSync(stage, { mode: 0o700 }); stageInode = lstatSync(stage).ino;
          for (const [name, content] of Object.entries(files)) {
            const path = join(stage, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            const fd = openSync(path, "wx", 0o600);
            try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
            chmodSync(path, 0o444);
          }
          for (const entry of this.tree(stage).entries.reverse()) if (entry.directory) { syncDirectory(entry.path); chmodSync(entry.path, 0o555); }
          const allocation = canonicalJson({ inode: stageInode, generation: start.target_generation, hash });
          this.store.transaction(() => this.store.exec("INSERT INTO command_receipts(scope,request_id,request_hash,result_json,created_at) VALUES('workspace.install',?,?,?,?)", id, digest(allocation), allocation, Date.now()));
          const journal = safe(this.store.root, "agent/tmp/workspace-allocation.json");
          if (exists(journal)) {
            const info = lstatSync(journal);
            check(info.isFile() && info.nlink === 1, "WORKSPACE_JOURNAL_INVALID", "工作区归属日志不可替换", 503);
          }
          durable(journal, JSON.stringify({ id }));
          this.options.onBoundary?.("staged"); signal.throwIfAborted();
          if (exists(this.cwd)) {
            previous = safe(this.store.root, `agent/tmp/previous-${id}`); previousInode = lstatSync(this.cwd).ino;
            this.move(this.cwd, previous); this.options.onBoundary?.("displaced");
          }
          this.move(stage, this.cwd); this.options.onBoundary?.("activated");
        }
        check(this.matches(files), "WORKSPACE_VERIFY_FAILED", "工作区激活后校验失败", 503);
        const result = this.store.exec("UPDATE agent_workspace_projection_state SET synced_generation=?,synced_knowledge_hash=?,content_hash=?,state='ready',error_code=NULL,updated_at=? WHERE id='maintenance' AND target_generation=? AND target_knowledge_hash=?", start.target_generation, this.options.knowledgeHash, hash, Date.now(), start.target_generation, this.options.knowledgeHash);
        check(Number(result.changes) === 1, "REVISION_CONFLICT", "投影目标已变化，不能标记旧目录就绪", 409);
        committed = true;
        try {
          this.options.onBoundary?.("synced"); if (previous) this.removeAllocated(previous, previousInode);
          const journal = safe(this.store.root, "agent/tmp/workspace-allocation.json");
          if (exists(journal)) { const info = lstatSync(journal); check(info.isFile() && info.nlink === 1, "WORKSPACE_JOURNAL_INVALID", "工作区归属日志无效", 503); unlinkSync(journal); syncDirectory(dirname(journal)); }
        } catch { /* Keep exact old resources for later explicit diagnostic cleanup. */ }
        return { generation: start.target_generation, hash, changed };
      } catch (error) {
        // Never roll back a committed database business operation. A failed file
        // activation remains gated until a fresh DB-driven rebuild succeeds.
        if (!committed) {
          try {
            this.store.directoryLease.assert();
            this.store.exec("UPDATE agent_workspace_projection_state SET state='failed',error_code=?,updated_at=? WHERE id='maintenance' AND target_generation=?", error instanceof AppError ? error.code : "WORKSPACE_IO_FAILED", Date.now(), start.target_generation);
            if (!exists(this.cwd) && previous && exists(previous)) this.move(previous, this.cwd);
            if (stage && exists(stage)) this.removeAllocated(stage, stageInode);
          } catch { /* Unknown paths/ownership stay retained, never guessed away. */ }
        }
        throw error instanceof AppError ? error : new AppError("WORKSPACE_IO_FAILED", "工作区同步失败，业务结果以数据库回执为准", 503);
      }
    });
  }

  async recover(signal: AbortSignal) {
    // Recovery is explicit and still requires a real external process-stop proof.
    // It does not kill guessed PIDs or settle database tasks on its own.
    return configCoordinator(this.store).withExclusive(async () => {
      this.quiescent(); const result = await this.synchronize(signal);
      configCoordinator(this.store).setMaintenance(null); return result;
    }, true);
  }

  async withReader<T>(signal: AbortSignal, action: (reader: ScopedWorkspaceReader) => Promise<T>): Promise<T> {
    signal.throwIfAborted(); check(!this.shared.active, "WORKSPACE_BUSY", "另一个共享维护任务正在运行", 409);
    this.shared.active = true;
    try {
      return await configCoordinator(this.store).withRead(async () => {
        this.store.directoryLease.assert(); this.quiescent();
        const state = projectionState(this.store);
        check(state.state === "ready" && state.target_generation === state.synced_generation && state.target_knowledge_hash === this.options.knowledgeHash, "WORKSPACE_NOT_READY", "工作区尚未同步就绪", 503);
        let tree: Tree;
        try {
          safe(this.store.root, "agent/workspace"); tree = this.tree(this.cwd);
          check(digest(canonicalJson(tree.files)) === state.content_hash && tree.entries.every(entry => entry.mode === (entry.directory ? 0o555 : 0o444)), "WORKSPACE_CHANGED", "工作区内容或权限已变化，须从数据库重建", 503);
        } catch {
          this.store.exec("UPDATE agent_workspace_projection_state SET state='failed',error_code='WORKSPACE_CHANGED',updated_at=? WHERE id='maintenance'", Date.now());
          throw new AppError("WORKSPACE_CHANGED", "工作区损坏或被修改，须重新同步", 503);
        }
        const reader = new ScopedWorkspaceReader(this.cwd, tree.files);
        try { signal.throwIfAborted(); return await action(reader); }
        finally {
          reader.revoke();
          try { this.quiescent(); }
          catch (error) {
            this.store.exec("UPDATE agent_workspace_projection_state SET state='failed',error_code='PROCESS_STOP_UNCONFIRMED',updated_at=? WHERE id='maintenance'", Date.now());
            configCoordinator(this.store).setMaintenance("维护进程退出未确认，禁止更新工作区；请先完成进程恢复"); throw error;
          }
        }
      });
    } finally { this.shared.active = false; }
  }
}
