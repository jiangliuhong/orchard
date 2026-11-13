import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, AppError } from "../domain/errors.js";
import { DirectoryLease } from "../migrations/lock.js";
import { durable, safe, syncDirectory } from "../migrations/journal.js";
import { parseConfigJson } from "../migrations/config.js";
import { AsyncReadWriteLock } from "./locks.js";
import { loadKnowledgeBundle, type KnowledgeBundle, type KnowledgeProfile } from "./knowledge-bundle.js";

export interface KnowledgeInstallationOperation { id: string; hash: string; hadWorkspace: boolean; succeeded: boolean }
export interface KnowledgeInstallationHost {
  current(): { hash: string; state: "initializing" | "ready" | "failed"; workspaceOwned: boolean } | undefined;
  pending(): KnowledgeInstallationOperation[];
  operation(id: string): KnowledgeInstallationOperation | undefined;
  begin(id: string, bundle: KnowledgeBundle, hadWorkspace: boolean): void;
  commit(id: string, bundle: KnowledgeBundle): void;
  fail(id: string, code: string): void;
  /** Confirm all old managed CLI connections have stopped, revoke tool authorizations and
   * reject unknown crash survivors. No model calls. Called under the exclusive workspace lock.
   */
  quiesce(signal: AbortSignal): Promise<void>;
}
interface InstallationJournal {
  formatVersion: 1; id: string; hash: string; hadWorkspace: boolean;
  phase: "preparing" | "staged" | "displaced" | "activated";
}
export interface KnowledgeWorkspaceLease {
  cwd: string; knowledgeHash: string; profile: KnowledgeProfile; contractVersion: string; toolPolicyVersion: string;
  rules: readonly string[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
const code = (error: unknown) => error instanceof AppError ? error.code : "KNOWLEDGE_IO_FAILED";
const workspaceLocks = new WeakMap<DirectoryLease, AsyncReadWriteLock>();

/** One shared workspace. Data ownership comes from the approved database, not a per-session
 * cwd or a self-authored manifest. The filesystem journal is only a recoverable installation
 * intent, authenticated against its persisted knowledge_install operation.
 */
export class KnowledgeService {
  private readonly lock: AsyncReadWriteLock;
  private bundle: KnowledgeBundle | undefined;
  private error: string | undefined;
  private initializations = 0;
  private readonly workspace: string;
  private readonly journal: string;
  constructor(private readonly options: {
    dataRoot: string; lease: DirectoryLease; host: KnowledgeInstallationHost;
    /** Internal test/package fixture override only; never take a source path from DTO/settings. */
    sourceRoot?: string;
    /** Internal progress/fault boundary, never supplied by an API caller. */
    onBoundary?: (phase: InstallationJournal["phase"] | "committed") => void;
  }) {
    DirectoryLease.validate(options.lease, options.dataRoot);
    let lock = workspaceLocks.get(options.lease);
    if (!lock) { lock = new AsyncReadWriteLock(); workspaceLocks.set(options.lease, lock); }
    this.lock = lock;
    this.workspace = safe(options.dataRoot, "agent/workspace");
    this.journal = safe(options.dataRoot, "agent/staging/knowledge-install.json");
  }
  private owned(relative: string): string {
    this.options.lease.assert(this.options.dataRoot);
    return safe(this.options.dataRoot, relative);
  }
  private directories(): void {
    for (const relative of ["agent", "agent/staging"]) {
      const path = this.owned(relative);
      if (!exists(path)) { mkdirSync(path, { mode: 0o700 }); syncDirectory(dirname(path)); }
      check(lstatSync(path).isDirectory(), "KNOWLEDGE_PATH_INVALID", "知识受管路径不是目录", 503);
    }
  }
  private paths(id: string) {
    check(uuid.test(id), "KNOWLEDGE_JOURNAL_INVALID", "知识安装标识无效", 503);
    return { stage: this.owned(`agent/staging/knowledge-${id}`), previous: this.owned(`agent/staging/previous-${id}`) };
  }
  /** Bound exact owned tree only. Never enumerate/delete the provider history or unknown staging roots. */
  private tree(root: string): { path: string; directory: boolean; mode: number }[] {
    const result: { path: string; directory: boolean; mode: number }[] = []; let bytes = 0;
    const visit = (path: string, depth: number) => {
      const info = lstatSync(path);
      check(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()) && (info.isDirectory() || info.nlink === 1), "KNOWLEDGE_PATH_INVALID", "知识路径包含链接或非常规文件", 503);
      check(depth <= 9 && result.length < 192 && info.size <= (info.isDirectory() ? Number.MAX_SAFE_INTEGER : 1024 * 1024), "KNOWLEDGE_PATH_INVALID", "受管知识目录超过预算", 503);
      if (info.isFile()) bytes += info.size;
      check(bytes <= 5 * 1024 * 1024, "KNOWLEDGE_PATH_INVALID", "受管知识目录超过字节预算", 503);
      result.push({ path, directory: info.isDirectory(), mode: info.mode & 0o777 });
      if (info.isDirectory()) {
        const handle = opendirSync(path);
        try { for (let entry = handle.readSync(); entry; entry = handle.readSync()) visit(join(path, entry.name), depth + 1); }
        finally { handle.closeSync(); }
      }
    };
    visit(root, 0); return result;
  }
  private removeOwned(root: string): void {
    if (!exists(root)) return;
    const tree = this.tree(root); // Validate every component before modifying even one path.
    for (const entry of tree) if (entry.directory) chmodSync(entry.path, 0o700);
    for (const entry of tree.reverse()) {
      if (entry.directory) rmdirSync(entry.path);
      else unlinkSync(entry.path);
    }
    syncDirectory(dirname(root));
  }
  private move(source: string, target: string): void {
    check(!exists(target), "KNOWLEDGE_RECOVERY_REQUIRED", "知识激活目标已存在，禁止覆盖", 503);
    const root = this.tree(source)[0]!;
    check(root.directory, "KNOWLEDGE_PATH_INVALID", "知识切换源不是目录", 503);
    // macOS requires write access to the moved directory to update its '..' entry when
    // crossing parents. Only the host, under the exclusive/quiesced lease, may do this.
    let moved = false;
    try { chmodSync(source, 0o700); renameSync(source, target); moved = true; }
    finally { chmodSync(moved ? target : source, root.mode); }
    syncDirectory(dirname(source)); syncDirectory(dirname(target));
  }
  private readJournal(): InstallationJournal | undefined {
    this.owned("agent/staging/knowledge-install.json");
    if (!exists(this.journal)) return;
    const info = lstatSync(this.journal);
    check(info.isFile() && info.nlink === 1 && info.size <= 4096, "KNOWLEDGE_JOURNAL_INVALID", "知识安装日志无效", 503);
    let value: InstallationJournal;
    try { value = parseConfigJson(readFileSync(this.journal, "utf8")) as unknown as InstallationJournal; }
    catch { throw new AppError("KNOWLEDGE_JOURNAL_INVALID", "知识安装日志损坏", 503); }
    check(value !== null && typeof value === "object" && Object.keys(value).length === 5 && value.formatVersion === 1 && typeof value.id === "string" && uuid.test(value.id) && typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash) && typeof value.hadWorkspace === "boolean" && ["preparing", "staged", "displaced", "activated"].includes(value.phase), "KNOWLEDGE_JOURNAL_INVALID", "知识安装日志声明无效", 503);
    const operation = this.options.host.operation(value.id);
    check(operation && operation.hash === value.hash && operation.hadWorkspace === value.hadWorkspace, "KNOWLEDGE_JOURNAL_INVALID", "知识日志没有匹配的持久安装操作", 503);
    return value;
  }
  private writeJournal(value: InstallationJournal): void {
    this.owned("agent/staging/knowledge-install.json");
    durable(this.journal, JSON.stringify(value));
  }
  private clearJournal(): void { unlinkSync(this.journal); syncDirectory(dirname(this.journal)); }

  private recoverJournal(): void {
    const journal = this.readJournal();
    if (!journal) {
      for (const operation of this.options.host.pending()) {
        const paths = this.paths(operation.id);
        check(!exists(paths.stage) && !exists(paths.previous), "KNOWLEDGE_RECOVERY_REQUIRED", "知识安装日志缺失但私有安装目录仍存在，禁止猜测删除", 503);
        this.options.host.fail(operation.id, "INSTALLATION_INTERRUPTED");
      }
      return;
    }
    const { stage, previous } = this.paths(journal.id), operation = this.options.host.operation(journal.id)!;
    const current = this.options.host.current();
    if (operation.succeeded && current?.state === "ready" && current.hash === journal.hash) {
      check(exists(this.workspace) && loadKnowledgeBundle(this.workspace).hash === journal.hash, "KNOWLEDGE_RECOVERY_REQUIRED", "已提交知识与工作区不一致，保留安装资源以供诊断", 503);
      this.removeOwned(stage); this.removeOwned(previous); this.clearJournal(); return;
    }
    // Roll back only an uncommitted filesystem switch; then materialize the CURRENT package.
    if (exists(previous)) {
      check(journal.hadWorkspace && !(exists(stage) && exists(this.workspace)), "KNOWLEDGE_RECOVERY_REQUIRED", "知识安装目录组合不明确", 503);
      if (exists(this.workspace)) this.move(this.workspace, stage);
      this.move(previous, this.workspace);
    } else if (!journal.hadWorkspace && exists(this.workspace)) {
      check(!exists(stage), "KNOWLEDGE_RECOVERY_REQUIRED", "初始知识安装状态不明确", 503);
      this.move(this.workspace, stage);
    }
    this.removeOwned(stage);
    this.options.host.fail(journal.id, "INSTALLATION_INTERRUPTED");
    this.clearJournal();
  }
  private materialize(stage: string, bundle: KnowledgeBundle): void {
    check(!exists(stage), "KNOWLEDGE_RECOVERY_REQUIRED", "知识 staging 已存在", 503);
    mkdirSync(stage, { mode: 0o700 }); syncDirectory(dirname(stage));
    for (const [relative, text] of Object.entries({ ...bundle.files, "manifest.json": bundle.manifestText })) {
      const path = join(stage, relative);
      const parents: string[] = []; let parent = dirname(path);
      while (parent !== stage) { parents.unshift(parent); parent = dirname(parent); }
      for (const directory of parents) if (!exists(directory)) mkdirSync(directory, { mode: 0o700 });
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(path, 0o444);
    }
    const tree = this.tree(stage);
    for (const entry of tree.reverse()) if (entry.directory) { syncDirectory(entry.path); chmodSync(entry.path, 0o555); }
    check(loadKnowledgeBundle(stage).hash === bundle.hash, "KNOWLEDGE_BUNDLE_INVALID", "物化知识校验失败", 503);
  }
  private matches(bundle: KnowledgeBundle): boolean {
    if (!exists(this.workspace)) return false;
    // Links/unknown ownership are not a repair license. Ordinary text/permission drift can be repaired.
    const tree = this.tree(this.workspace);
    try { return tree.every(entry => entry.mode === (entry.directory ? 0o555 : 0o444)) && loadKnowledgeBundle(this.workspace).hash === bundle.hash; }
    catch { return false; }
  }

  async initialize(signal: AbortSignal): Promise<{ hash: string; changed: boolean }> {
    signal.throwIfAborted();
    this.initializations++;
    try { return await this.lock.write(signal, async () => {
      this.bundle = undefined; this.error = undefined;
      try {
        this.options.lease.assert(this.options.dataRoot);
        const source = loadKnowledgeBundle(this.options.sourceRoot);
        await this.options.host.quiesce(signal); signal.throwIfAborted();
        this.options.lease.assert(this.options.dataRoot); this.directories();
        this.recoverJournal();
        const prior = this.options.host.current();
        check(!exists(this.workspace) || prior?.workspaceOwned, "KNOWLEDGE_WORKSPACE_UNOWNED", "现有 workspace 无平台持久归属，禁止覆盖", 503);
        if (prior?.state === "ready" && prior.hash === source.hash && this.matches(source)) {
          this.bundle = source; return { hash: source.hash, changed: false };
        }
        if (exists(this.workspace)) this.tree(this.workspace);
        const id = randomUUID(), { stage, previous } = this.paths(id);
        const journal: InstallationJournal = { formatVersion: 1, id, hash: source.hash, hadWorkspace: exists(this.workspace), phase: "preparing" };
        this.options.host.begin(id, source, journal.hadWorkspace);
        try {
          this.writeJournal(journal); this.options.onBoundary?.("preparing");
          this.materialize(stage, source);
          journal.phase = "staged"; this.writeJournal(journal); this.options.onBoundary?.("staged");
          if (journal.hadWorkspace) this.move(this.workspace, previous);
          journal.phase = "displaced"; this.writeJournal(journal); this.options.onBoundary?.("displaced");
          this.move(stage, this.workspace);
          journal.phase = "activated"; this.writeJournal(journal); this.options.onBoundary?.("activated");
          check(this.matches(source), "KNOWLEDGE_BUNDLE_INVALID", "激活知识校验失败", 503);
          this.options.host.commit(id, source); this.options.onBoundary?.("committed");
          this.removeOwned(previous); this.clearJournal();
        } catch (error) {
          // Keep the journal/reference on unknown states; never delete arbitrary orphan directories.
          try { this.recoverJournal(); } catch { /* Recovery is retried on next initialization. */ }
          this.options.host.fail(id, code(error));
          throw error;
        }
        this.bundle = source; return { hash: source.hash, changed: true };
      } catch (error) {
        this.bundle = undefined; this.error = code(error);
        throw error instanceof AppError ? error : new AppError(this.error, "内置知识初始化失败，请检查受管目录", 503);
      }
    }); } finally { this.initializations--; }
  }

  async withWorkspace<T>(profile: KnowledgeProfile, expectedHash: string, signal: AbortSignal, action: (lease: KnowledgeWorkspaceLease) => Promise<T>): Promise<T> {
    return this.lock.read(signal, async () => {
      this.options.lease.assert(this.options.dataRoot);
      const bundle = this.bundle, current = this.options.host.current();
      check(bundle && bundle.hash === expectedHash && current?.hash === expectedHash && current.state === "ready", "KNOWLEDGE_UNAVAILABLE", "共享知识尚未就绪或已更新", 503);
      check(Object.hasOwn(bundle.manifest.profiles, profile), "KNOWLEDGE_PROFILE_INVALID", "知识 profile 无效");
      let matches = false;
      try { matches = this.matches(bundle); } catch { /* Never expose filesystem paths from a lease failure. */ }
      if (!matches) { this.bundle = undefined; this.error = "KNOWLEDGE_WORKSPACE_CHANGED"; throw new AppError(this.error, "共享知识已变化，请重新初始化", 503); }
      const selected = bundle.manifest.profiles[profile];
      return action(Object.freeze({ cwd: this.workspace, knowledgeHash: bundle.hash, profile, contractVersion: bundle.manifest.contractVersion, toolPolicyVersion: bundle.manifest.toolPolicyVersion, rules: Object.freeze(["AGENTS.md", selected.skill, ...selected.documents]) }));
    });
  }
  snapshot(): { ready: boolean; initializing: boolean; hash?: string; error?: string; files: readonly string[] } {
    const current = this.options.host.current();
    const ready = this.initializations === 0 && !!this.bundle && current?.state === "ready" && current.hash === this.bundle.hash;
    return { ready, initializing: this.initializations > 0, ...(ready ? { hash: this.bundle!.hash } : {}), ...(this.error ? { error: this.error } : {}), files: Object.freeze(ready ? ["manifest.json", ...Object.keys(this.bundle!.files)].sort() : []) };
  }
  readFile(relative: string): string {
    const bundle = this.bundle, current = this.options.host.current();
    check(bundle && current?.state === "ready" && current.hash === bundle.hash, "KNOWLEDGE_UNAVAILABLE", "内置知识尚未就绪", 503);
    if (relative === "manifest.json") return bundle.manifestText;
    check(Object.hasOwn(bundle.files, relative), "NOT_FOUND", "内置知识文件不存在", 404);
    return bundle.files[relative]!;
  }
}
