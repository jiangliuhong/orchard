import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class GitRepositoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'GitRepositoryError'; }
}
export type GitFiles = Record<string, string>;
export interface GitIdentity { name: string; email: string }
export interface GitBinding {
  id: string; remoteUrl: string; branch: string; configDir: string; repositoryPath: string;
  snapshotState: 'empty' | 'valid' | 'unsupported'; createdAt: string;
}
export interface GitRepositoryOptions {
  validateSnapshot?: (files: GitFiles) => unknown;
  /** Only tests may map an already validated SSH/HTTPS URL to a local bare fixture. */
  testTransport?: (remoteUrl: string) => string;
  timeoutMs?: number;
  /** Fault injection for process-kill tests; never sourced from API input. */
  testCheckpoint?: (phase: string) => void | Promise<void>;
}
export interface CommitPreviewInput { files: GitFiles; revision: string; message: string; push?: boolean; regenerate?: boolean }
export interface GitFileDiff { path: string; before: string | null; after: string | null }
export interface GitCommitPreview {
  token: string; bindingId: string; head: string | null; remoteSha: string | null; baseSha: string | null;
  filesDigest: string; revision: string; expiresAt: number; diff: GitFileDiff[]; cumulativeDiff: GitFileDiff[];
  push: boolean; regenerate: boolean;
}
export interface GitCommitResult { sha: string | null; committed: boolean; pushed: boolean; remoteState: 'confirmed' | 'not-pushed' | 'unknown'; pushError?: string; backupRef?: string }
interface SavedPreview { view: GitCommitPreview; input: CommitPreviewInput }
interface TreeEntry { mode: string; sha: string; path: string }
const MAX_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const locks = new Map<string, Promise<unknown>>();
function fail(code: string, message: string): never { throw new GitRepositoryError(code, message); }
function safePath(path: string) {
  if (!path || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git') || path.startsWith('/') || /^[a-z]:/i.test(path)) fail('INVALID_PATH', 'Unsafe repository path');
  return path;
}
export function validateGitRemote(remote: string): string {
  if (!remote || /[\s\x00-\x1f]/.test(remote) || remote.startsWith('-')) fail('INVALID_REMOTE', 'Use an SSH or HTTPS repository URL');
  if (/^[\w.-]+@[\w.-]+:[^/].+$/.test(remote)) return remote;
  let url: URL; try { url = new URL(remote); } catch { return fail('INVALID_REMOTE', 'Use an SSH or HTTPS repository URL'); }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) fail('INVALID_REMOTE', 'Only SSH/HTTPS without embedded credentials is accepted');
  return remote;
}
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function diff(before: GitFiles, after: GitFiles): GitFileDiff[] { return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(p => before[p] !== after[p]).map(path => ({ path, before: before[path] ?? null, after: after[path] ?? null })); }
async function exists(path: string) { try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
async function safeAncestors(path: string) {
  const absolute = resolve(path); let current = '/';
  for (const part of absolute.split('/').filter(Boolean)) { current = join(current, part); if (await exists(current)) { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) fail('INVALID_PATH', 'Symbolic link in managed repository path'); } }
}
async function atomicJson(path: string, value: unknown) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`; const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, path); const directory = await fs.open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

/** The application owns the data-dir lease; this service serializes all Git operations across instances. */
export class GitRepositoryService {
  readonly root: string;
  private previews = new Map<string, SavedPreview>();
  constructor(dataDir: string, private options: GitRepositoryOptions = {}) { this.root = resolve(dataDir, 'config-git'); }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.root) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn); locks.set(this.root, next);
    try { return await next; } finally { if (locks.get(this.root) === next) locks.delete(this.root); }
  }
  private async git(cwd: string, args: string[], input?: string | Buffer, extra: Record<string, string> = {}, max = 4 * 1024 * 1024, encoding: BufferEncoding = 'utf8'): Promise<string> {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes', GIT_CONFIG_NOSYSTEM: '0', LC_ALL: 'C', ...extra });
    const flags = ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.sshCommand=ssh -oBatchMode=yes -oStrictHostKeyChecking=yes','-c','commit.gpgSign=false','-c','tag.gpgSign=false','-c','core.attributesFile=/dev/null','-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.ssh.allow=always','-c','submodule.recurse=false','-c','core.fsync=committed'];
    if (this.options.testTransport) flags.push('-c','protocol.file.allow=always');
    return new Promise((res, rej) => {
      const child = spawn('git', [...flags, ...args], { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
      const out: Buffer[] = [], err: Buffer[] = []; let size = 0, errorSize = 0, failure: string | null = null;
      const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} };
      const timer = setTimeout(() => { failure = 'GIT_TIMEOUT'; kill(); }, this.options.timeoutMs ?? (['fetch','push','clone'].includes(args[0]) ? 120000 : 30000));
      child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > max) { failure = 'OUTPUT_LIMIT'; kill(); } else out.push(b); });
      child.stderr.on('data', (b: Buffer) => { errorSize += b.length; if (errorSize <= 65536) err.push(b); });
      child.on('error', e => { clearTimeout(timer); rej(e); });
      child.on('close', code => { clearTimeout(timer); if (code === 0 && !failure) res(Buffer.concat(out).toString(encoding)); else {
        const detail = Buffer.concat(err).toString() + (args[0] === 'push' ? Buffer.concat(out).toString() : '');
        const kind = failure ?? (/Authentication failed|Permission denied|Host key verification failed|could not read Username/i.test(detail) ? 'AUTH_FAILED' : args[0] === 'push' ? (/rejected|non-fast-forward|requested URL returned error:\s*403\b/i.test(detail) ? 'PUSH_REJECTED' : 'REMOTE_UNKNOWN') : 'GIT_FAILED');
        // Raw transport output can include credential-helper secrets; never return it.
        rej(new GitRepositoryError(kind, `Git ${args[0]} failed${kind === 'AUTH_FAILED' ? '; verify credentials and SSH host keys on the Orchard host' : ''}`));
      } });
      child.stdin.on('error', () => {}); child.stdin.end(input);
    });
  }
  private transport(url: string) { validateGitRemote(url); return this.options.testTransport?.(url) ?? url; }
  async checkRemote(remoteUrl: string) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 }); await safeAncestors(this.root);
    const output = await this.git(this.root, ['ls-remote','--heads','--',this.transport(remoteUrl)]);
    return { branches: output.trim().split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split('\t'); return { name: ref.replace(/^refs\/heads\//, ''), sha }; }), pushPermission: 'unverified' as const };
  }
  async getBinding(): Promise<GitBinding | null> {
    await safeAncestors(this.root); const path = join(this.root, 'binding.json'); if (!await exists(path)) return null;
    await safeAncestors(path); const binding = JSON.parse(await fs.readFile(path, 'utf8')) as GitBinding;
    if (!binding) return null;
    if (!/^[a-f0-9-]{36}$/.test(binding.id)) fail('INVALID_BINDING', 'Invalid binding record');
    binding.repositoryPath = join(this.root, 'repositories', binding.id); safePath(binding.configDir); validateGitRemote(binding.remoteUrl);
    await safeAncestors(binding.repositoryPath); return binding;
  }
  private async binding() { return await this.getBinding() ?? fail('NOT_BOUND', 'No Git repository is bound'); }
  private async ref(b: GitBinding, name: string): Promise<string | null> { try { return (await this.git(b.repositoryPath,['rev-parse','--verify',name])).trim(); } catch (e) { if (e instanceof GitRepositoryError && e.code === 'GIT_FAILED') return null; throw e; } }
  private async head(b: GitBinding) { return this.ref(b, `refs/heads/${b.branch}`); }
  private remoteRef(b: GitBinding) { return `refs/remotes/origin/${b.branch}`; }
  private async tree(b: GitBinding, sha: string | null): Promise<TreeEntry[]> {
    if (!sha) return []; if (!SHA.test(sha)) fail('INVALID_SHA', 'A full commit SHA is required');
    const lines = (await this.git(b.repositoryPath, ['ls-tree','-rz','--full-tree',sha], undefined, {}, MAX_BYTES)).split('\0').filter(Boolean);
    if (lines.length > 10000) fail('SNAPSHOT_LIMIT', 'Repository exceeds file count limit');
    return lines.map(line => { const tab = line.indexOf('\t'), [mode, type, object] = line.slice(0, tab).split(' '), path = safePath(line.slice(tab + 1)); if (type !== 'blob' || !['100644','100755'].includes(mode)) fail('UNSAFE_TREE','Symlinks and submodules are not accepted'); return { mode, sha: object, path }; });
  }
  private async files(b: GitBinding, sha: string | null, managed = true): Promise<GitFiles> {
    const result: GitFiles = Object.create(null); let bytes = 0;
    for (const entry of await this.tree(b, sha)) { if (managed && !entry.path.startsWith(`${b.configDir}/`)) continue;
      const raw = Buffer.from(await this.git(b.repositoryPath,['cat-file','blob',entry.sha],undefined,{},MAX_BYTES,'latin1'),'latin1');
      const text = raw.toString('utf8'); if (!Buffer.from(text).equals(raw)) fail('INVALID_SNAPSHOT','Snapshot files must be valid UTF-8'); bytes += raw.length; if (bytes > MAX_BYTES) fail('SNAPSHOT_LIMIT','Snapshot exceeds size limit');
      result[managed ? entry.path.slice(b.configDir.length + 1) : entry.path] = text;
    } return result;
  }
  private validateFiles(files: GitFiles) { let size = 0; if (Object.keys(files).length > 10000) fail('SNAPSHOT_LIMIT','Too many files'); for (const [path, value] of Object.entries(files)) { safePath(path); if (typeof value !== 'string') fail('INVALID_SNAPSHOT','File contents must be text'); size += Buffer.byteLength(value); } if (size > MAX_BYTES) fail('SNAPSHOT_LIMIT','Snapshot exceeds size limit'); }
  private async inspect(b: GitBinding, sha: string | null): Promise<GitBinding['snapshotState']> {
    const entries = await this.tree(b,sha);
    if (entries.some(e=>e.path===b.configDir || b.configDir.startsWith(e.path+'/'))) fail('INVALID_PATH','Configuration directory is occupied by a file');
    const files = await this.files(b, sha); if (!Object.keys(files).length) return 'empty';
    try { const manifest = JSON.parse(files['manifest.json'] ?? '{}'); if (manifest.formatVersion > 2) return 'unsupported'; } catch { fail('INVALID_SNAPSHOT','Existing configuration directory has an invalid manifest'); }
    if (!this.options.validateSnapshot) fail('INVALID_SNAPSHOT','Snapshot validator is required for nonempty configuration directory');
    this.options.validateSnapshot(files); return 'valid';
  }
  async bind(input: { remoteUrl: string; branch: string; configDir?: string; identity?: GitIdentity }): Promise<GitBinding> { return this.exclusive(async () => {
    if (await this.getBinding()) fail('ALREADY_BOUND','Unbind the current repository first');
    const remote = this.transport(input.remoteUrl); const configDir = safePath((input.configDir ?? 'orchard-config').replace(/\/$/, ''));
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    if (input.branch.startsWith('-')) fail('INVALID_BRANCH','Invalid branch');
    await this.git(this.root,['check-ref-format',`refs/heads/${input.branch}`]);
    const id = randomUUID(), repositoryPath = join(this.root,'repositories',id); await fs.mkdir(dirname(repositoryPath),{recursive:true,mode:0o700});
    await this.git(this.root,['clone','--no-checkout','--no-recurse-submodules','--template=','--',remote,repositoryPath]);
    const b: GitBinding = { id, remoteUrl: input.remoteUrl, branch: input.branch, configDir, repositoryPath, snapshotState:'empty',createdAt:new Date().toISOString() };
    await this.git(repositoryPath,['symbolic-ref','HEAD',`refs/heads/${b.branch}`]);
    const target = await this.ref(b,this.remoteRef(b));
    if (!target && (await this.checkRemote(input.remoteUrl)).branches.length) fail('INVALID_BRANCH','Selected remote branch does not exist');
    if (target) await this.git(repositoryPath,['update-ref',`refs/heads/${b.branch}`,target]);
    b.snapshotState = await this.inspect(b,target);
    if (input.identity) { if (!input.identity.name.trim() || !input.identity.email.trim() || /[\r\n\0]/.test(input.identity.name+input.identity.email)) fail('INVALID_IDENTITY','Name and email are required'); await this.git(repositoryPath,['config','--local','user.name',input.identity.name]); await this.git(repositoryPath,['config','--local','user.email',input.identity.email]); }
    await this.materialize(b,null,target); await atomicJson(join(this.root,'binding.json'),b); return b;
  }); }
  private async clean(b: GitBinding) {
    const symbolic = (await this.git(b.repositoryPath,['symbolic-ref','HEAD'])).trim(); if (symbolic !== `refs/heads/${b.branch}`) fail('DIRTY_REPOSITORY','Repository branch changed');
    for (const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','index.lock']) if (await exists(join(b.repositoryPath,'.git',name))) fail('DIRTY_REPOSITORY','Repository operation is in progress');
    // Read raw blobs and the index: never invoke status/add, which can execute clean filters.
    const head = await this.head(b); const entries = await this.tree(b,head);
    const indexed = (await this.git(b.repositoryPath,['ls-files','--stage','-z'])).split('\0').filter(Boolean);
    const expected = entries.map(e=>`${e.mode} ${e.sha} 0\t${e.path}`).sort();
    if (JSON.stringify(indexed.sort()) !== JSON.stringify(expected)) fail('DIRTY_REPOSITORY','Index has staged changes');
    const tracked = new Set(entries.map(e=>e.path));
    const walk = async (dir: string, prefix = ''): Promise<void> => { for (const name of await fs.readdir(dir)) { if (!prefix && name === '.git') continue; const relative = prefix + name, path = join(dir,name); const stat = await fs.lstat(path); if (stat.isSymbolicLink()) fail('DIRTY_REPOSITORY','Worktree contains a symbolic link'); if (stat.isDirectory()) await walk(path,relative+'/'); else if (!tracked.has(relative)) fail('DIRTY_REPOSITORY',`Untracked file: ${relative}`); } };
    await walk(b.repositoryPath);
    for (const e of entries) { const path = join(b.repositoryPath,e.path); await safeAncestors(path); if (!await exists(path)) fail('DIRTY_REPOSITORY',`Missing file: ${e.path}`); const data = await fs.readFile(path); const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex'); if (hash !== e.sha || ((await fs.stat(path)).mode & 0o111 ? '100755':'100644') !== e.mode) fail('DIRTY_REPOSITORY',`Modified file: ${e.path}`); }
  }
  private async materialize(b: GitBinding, previous: string | null, next: string | null, recovering = false) {
    const old = await this.tree(b, previous), entries = await this.tree(b, next);
    const oldFiles = new Map(old.map(e => [e.path, e])), nextFiles = new Map(entries.map(e => [e.path, e]));
    const directories = (tree: TreeEntry[]) => {
      const result = new Set<string>();
      for (const entry of tree) for (let path = dirname(entry.path); path !== '.'; path = dirname(path)) result.add(path);
      return result;
    };
    const oldDirectories = directories(old), nextDirectories = directories(entries);
    const conflict = () => fail(recovering ? 'RECOVERY_REQUIRED' : 'DIRTY_REPOSITORY', 'External edit during Git worktree installation');
    const syncDirectory = async (path: string) => { const handle = await fs.open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); } };
    const assertUntouched = async (path: string, required = false) => {
      const file = join(b.repositoryPath, path); await safeAncestors(file);
      if (!await exists(file)) { if (required) conflict(); return; }
      const stat = await fs.lstat(file); if (!stat.isFile()) conflict();
      const bytes = await fs.readFile(file), hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const mode = stat.mode & 0o111 ? '100755' : '100644';
      const matches = (entry?: TreeEntry) => entry?.sha === hash && entry.mode === mode;
      if (!matches(oldFiles.get(path)) && !(recovering && matches(nextFiles.get(path)))) conflict();
    };
    // Walk the actual worktree: after a partial transition an old file can already
    // be a directory, or an old directory can already be its replacement file.
    const presentFiles = new Set<string>();
    const inspect = async (directory: string, prefix = '') => {
      for (const name of await fs.readdir(directory)) {
        if (!prefix && name === '.git') continue;
        const relative = prefix + name, path = join(directory, name), stat = await fs.lstat(path);
        if (stat.isSymbolicLink()) conflict();
        if (stat.isDirectory()) {
          if (oldFiles.has(relative) && !(recovering && nextDirectories.has(relative))) conflict();
          await inspect(path, relative + '/');
        } else { await assertUntouched(relative, true); presentFiles.add(relative); }
      }
    };
    await inspect(b.repositoryPath);
    if (!recovering && old.some(e => !presentFiles.has(e.path))) conflict();
    for (const path of presentFiles) if (!nextFiles.has(path)) {
      await assertUntouched(path, !recovering);
      await fs.rm(join(b.repositoryPath, path), { force: true });
      await syncDirectory(dirname(join(b.repositoryPath, path)));
      await this.options.testCheckpoint?.('worktree-file-removed');
    }
    // Never recursively remove a directory: unknown files must stop recovery.
    for (const path of [...oldDirectories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      if (nextDirectories.has(path)) continue;
      // A replacement file may already hide all of its former descendants.
      if ([...presentFiles].some(file => nextFiles.has(file) && (path === file || path.startsWith(file + '/')))) continue;
      const absolute = join(b.repositoryPath, path); await safeAncestors(absolute);
      if (!await exists(absolute)) continue;
      if (!(await fs.lstat(absolute)).isDirectory()) conflict();
      try { await fs.rmdir(absolute); } catch (error) {
        if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) conflict();
        throw error;
      }
      await syncDirectory(dirname(absolute));
      await this.options.testCheckpoint?.('worktree-directory-removed');
    }
    for (const entry of entries) {
      const prior = oldFiles.get(entry.path);
      if (prior?.sha === entry.sha && prior.mode === entry.mode && presentFiles.has(entry.path)) continue;
      await assertUntouched(entry.path, !recovering && !!prior);
      const path = join(b.repositoryPath, entry.path); await fs.mkdir(dirname(path), { recursive: true });
      const data = Buffer.from(await this.git(b.repositoryPath, ['cat-file', 'blob', entry.sha], undefined, {}, MAX_BYTES, 'latin1'), 'latin1');
      const temporary = join(this.root, 'staging', `blob-${randomUUID()}`); await fs.mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, 'wx', entry.mode === '100755' ? 0o755 : 0o644);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await assertUntouched(entry.path, !recovering && !!prior);
      await fs.rename(temporary, path); await syncDirectory(dirname(path));
      await this.options.testCheckpoint?.('worktree-file-installed');
    }
    await this.git(b.repositoryPath, next ? ['read-tree', next] : ['read-tree', '--empty']);
  }
  private async fetchInternal(b: GitBinding) {
    await this.clean(b);
    await this.options.testCheckpoint?.('before-fetch');
    await this.git(b.repositoryPath,['fetch','--no-tags','--no-recurse-submodules','--prune','--',this.transport(b.remoteUrl),`+refs/heads/*:refs/remotes/origin/*`]);
  }
  async remoteSyncSource() { return this.exclusive(async () => {
    const b = await this.binding(); await this.clean(b); await this.fetchInternal(b);
    const sourceSha = await this.ref(b, this.remoteRef(b));
    if (!sourceSha) fail('REMOTE_BRANCH_MISSING', 'Bound remote branch does not exist');
    const fetchedAt = new Date().toISOString();
    const snapshotState = await this.inspect(b, sourceSha);
    const files = snapshotState === 'valid' ? await this.files(b, sourceSha) : {};
    const supportedCategories: string[] = snapshotState === 'valid' ? JSON.parse(files['manifest.json']).categories : [];
    const metadata = (await this.git(b.repositoryPath, ['show', '-s', '--format=%s%x00%an%x00%cI', sourceSha])).trimEnd().split('\0');
    return { bindingId: b.id, branch: b.branch, sourceSha, fetchedAt, commit: { subject: metadata[0], author: metadata[1], committedAt: metadata[2] }, snapshotState, supportedCategories };
  }); }
  async fetch() { return this.exclusive(async()=>{const b=await this.binding(); await this.fetchInternal(b); return {...await this.statusInternal(b),remoteFresh:true};}); }
  private async statusInternal(b: GitBinding) {
    let dirty = false, dirtyReason: string | undefined; try { await this.clean(b); } catch(e) { if (!(e instanceof GitRepositoryError) || e.code !== 'DIRTY_REPOSITORY') throw e; dirty=true; dirtyReason=e.message; }
    const head = await this.head(b), remoteSha = await this.ref(b,this.remoteRef(b)); let ahead=0,behind=0;
    if(head && remoteSha) [ahead,behind]=(await this.git(b.repositoryPath,['rev-list','--left-right','--count',`${head}...${remoteSha}`])).trim().split(/\s+/).map(Number);
    else if(head) ahead=Number((await this.git(b.repositoryPath,['rev-list','--count',head])).trim()); else if(remoteSha) behind=Number((await this.git(b.repositoryPath,['rev-list','--count',remoteSha])).trim());
    return { binding:b,head,remoteSha,ahead,behind,diverged:ahead>0&&behind>0,dirty,dirtyReason,remoteFresh:false as boolean };
  }
  async status() { return this.exclusive(async()=>this.statusInternal(await this.binding())); }
  async readSnapshot(sha: string) { return this.exclusive(async()=>{const b=await this.binding(); await this.clean(b); if(!SHA.test(sha)) fail('INVALID_SHA','A full commit SHA is required'); await this.git(b.repositoryPath,['cat-file','-e',`${sha}^{commit}`]); return this.files(b,sha);}); }
  async history(options: { source?: 'local'|'remote'; startSha?: string; offset?: number; limit?: number } = {}) { return this.exclusive(async()=>{
    const b=await this.binding(), startSha=options.startSha ?? await this.ref(b,options.source==='remote'?this.remoteRef(b):`refs/heads/${b.branch}`);
    if(!startSha) return {startSha:null,commits:[],nextOffset:null}; if(!SHA.test(startSha)) fail('INVALID_SHA','A full commit SHA is required');
    const offset=options.offset??0, limit=options.limit??50; if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100) fail('INVALID_PAGE','Invalid history page');
    const output=await this.git(b.repositoryPath,['log',`--skip=${offset}`,`--max-count=${limit}`,'--format=%H%x00%an%x00%aI%x00%s%x00',startSha,'--',b.configDir]);
    const fields=output.split('\0'); const commits=[]; for(let i=0;i+3<fields.length;i+=4) commits.push({sha:fields[i].trim(),author:fields[i+1],date:fields[i+2],message:fields[i+3]});
    return {startSha,commits,nextOffset:commits.length===limit?offset+limit:null};
  }); }
  async previewCommit(input: CommitPreviewInput): Promise<GitCommitPreview> { return this.exclusive(async()=>{
    const b=await this.binding(); await this.clean(b); this.validateFiles(input.files); this.options.validateSnapshot?.(input.files);
    if(!input.message.trim() || input.message.includes('\0')) fail('INVALID_MESSAGE','Commit message is required');
    if(input.push || input.regenerate) await this.fetchInternal(b);
    let status=await this.statusInternal(b);
    if(input.push&&status.diverged&&!input.regenerate) fail('REMOTE_DIVERGED','Remote and local history diverged; regenerate explicitly');
    if(input.regenerate&&!status.remoteSha) fail('REMOTE_DIVERGED','No remote branch to regenerate against');
    if(input.push&&!input.regenerate&&!status.ahead&&status.behind&&status.remoteSha) {
      await this.move(b,status.head,status.remoteSha); status=await this.statusInternal(b);
    }
    const baseSha=input.regenerate?status.remoteSha:status.head;
    if(await this.inspect(b,baseSha)==='unsupported') fail('FORMAT_UNSUPPORTED','Newer snapshot format cannot be overwritten');
    const before=await this.files(b,baseSha), remoteFiles=await this.files(b,status.remoteSha);
    const view:GitCommitPreview={token:randomUUID(),bindingId:b.id,head:status.head,remoteSha:status.remoteSha,baseSha,filesDigest:digest(Object.entries(input.files).sort()),revision:input.revision,expiresAt:Date.now()+30*60*1000,diff:diff(before,input.files),cumulativeDiff:diff(remoteFiles,input.files),push:!!input.push,regenerate:!!input.regenerate};
    for (const [token, saved] of this.previews) if (saved.view.expiresAt < Date.now()) this.previews.delete(token);
    this.previews.set(view.token,{view:structuredClone(view),input:structuredClone(input)}); return view;
  }); }
  private async move(b:GitBinding,old:string|null,next:string) {
    // A durable intent makes a crash visible; no automatic reset/clean of external edits.
    const journal=join(this.root,'operations',`move-${randomUUID()}.json`); await atomicJson(journal,{bindingId:b.id,phase:'prepared',old,next});
    await this.clean(b); await this.git(b.repositoryPath,['update-ref',`refs/heads/${b.branch}`,next,old??'0'.repeat(40)]);
    await atomicJson(journal,{bindingId:b.id,phase:'ref-updated',old,next});
    await this.options.testCheckpoint?.('ref-updated');
    await this.materialize(b,old,next); await atomicJson(journal,{bindingId:b.id,phase:'completed',old,next});
    await this.options.testCheckpoint?.('worktree-installed');
  }
  private async createCommit(b:GitBinding,p:SavedPreview):Promise<string> {
    const index=join(this.root,'staging',randomUUID()+'.index'); await fs.mkdir(dirname(index),{recursive:true,mode:0o700}); const env={GIT_INDEX_FILE:index};
    try {
      await this.git(b.repositoryPath,p.view.baseSha?['read-tree',p.view.baseSha]:['read-tree','--empty'],undefined,env);
      const old=(await this.tree(b,p.view.baseSha)).filter(e=>e.path.startsWith(b.configDir+'/'));
      if(old.length) await this.git(b.repositoryPath,['update-index','--force-remove','-z','--stdin'],old.map(e=>e.path+'\0').join(''),env);
      for(const [path,text] of Object.entries(p.input.files).sort()) { const sha=(await this.git(b.repositoryPath,['hash-object','-w','--stdin','--no-filters'],text)).trim(); await this.git(b.repositoryPath,['update-index','--add','--cacheinfo',`100644,${sha},${b.configDir}/${path}`],undefined,env); }
      const tree=(await this.git(b.repositoryPath,['write-tree'],undefined,env)).trim();
      return (await this.git(b.repositoryPath,['commit-tree',tree,...(p.view.baseSha?['-p',p.view.baseSha]:[])],p.input.message+'\n')).trim();
    } finally { await fs.rm(index,{force:true}); }
  }
  async confirmCommit(input:{token:string;revision:string;requestId:string}, validateRevision?: () => void):Promise<GitCommitResult> { return this.exclusive(async()=>{
    if(!/^[\w-]{1,128}$/.test(input.requestId)) fail('INVALID_REQUEST','Invalid request ID');
    const receipt=join(this.root,'operations',`commit-${input.requestId}.json`), requestHash=digest(input);
    if(await exists(receipt)) { const saved=JSON.parse(await fs.readFile(receipt,'utf8')); if(saved.requestHash!==requestHash) fail('REQUEST_CONFLICT','Request ID reused with different input'); if(saved.result) return saved.result; fail('RECOVERY_REQUIRED','Prior commit attempt requires inspection; no duplicate commit was created'); }
    const p=this.previews.get(input.token), b=await this.binding();
    if(!p||p.view.expiresAt<Date.now()||p.view.bindingId!==b.id||p.view.revision!==input.revision) fail('PREVIEW_EXPIRED','Preview expired');
    await this.clean(b); if(p.view.push||p.view.regenerate) await this.fetchInternal(b);
    if(await this.head(b)!==p.view.head || ((p.view.push||p.view.regenerate)&&await this.ref(b,this.remoteRef(b))!==p.view.remoteSha)) fail('PREVIEW_EXPIRED','Repository changed since preview');
    // Network observation is complete. Accept the immutable preview only after
    // the caller synchronously rechecks its current application revision.
    validateRevision?.();
    const intent = { requestHash, bindingId:b.id, old:p.view.head, base:p.view.baseSha, push:p.view.push, remoteSha:p.view.remoteSha };
    await atomicJson(receipt,{...intent,phase:'accepted'});
    await this.options.testCheckpoint?.('accepted');
    let sha=p.view.head, backupRef:string|undefined;
    if(p.view.diff.length || (p.view.regenerate&&p.view.baseSha!==p.view.head)) {
      sha=p.view.diff.length?await this.createCommit(b,p):p.view.baseSha;
      if(p.view.regenerate&&p.view.head) {backupRef=`refs/orchard/backups/${randomUUID()}`; await this.git(b.repositoryPath,['update-ref',backupRef,p.view.head]);}
      await atomicJson(receipt,{...intent,phase:'commit-created',sha,backupRef});
      await this.options.testCheckpoint?.('commit-created');
      if(sha) await this.move(b,p.view.head,sha);
    }
    let result:GitCommitResult={sha,committed:sha!==p.view.head,pushed:false,remoteState:'not-pushed',...(backupRef?{backupRef}:{})};
    await atomicJson(receipt,{...intent,phase:'local-committed',sha,backupRef,result});
    await this.options.testCheckpoint?.('local-committed');
    if(p.view.push&&sha) {try {await this.pushInternal(b);await this.options.testCheckpoint?.('pushed');result={...result,pushed:true,remoteState:'confirmed'};}catch(e){result={...result,remoteState:'unknown',pushError:e instanceof GitRepositoryError?e.code:'REMOTE_UNKNOWN'};}}
    await atomicJson(receipt,{...intent,phase:'completed',sha,backupRef,result}); this.previews.delete(input.token); return result;
  }); }
  private async pushInternal(b:GitBinding) {
    await this.fetchInternal(b); const status=await this.statusInternal(b);
    if(status.diverged||status.behind) fail('REMOTE_DIVERGED','Remote contains changes; preview again');
    if(!status.head) return {sha:null,pushed:false};
    if(status.ahead) await this.git(b.repositoryPath,['push','--porcelain','--no-verify','--',this.transport(b.remoteUrl),`${status.head}:refs/heads/${b.branch}`]);
    await this.fetchInternal(b); return {sha:status.head,pushed:true};
  }
  async push() {return this.exclusive(async()=>this.pushInternal(await this.binding()));}
  /** Complete a ref update interrupted during raw worktree installation. Refuses external edits. */
  async recover(): Promise<{ recovered: number }> { return this.exclusive(async()=>{
    const b=await this.getBinding(), directory=join(this.root,'operations'); let recovered=0;
    if(!b) return {recovered};
    if(!await exists(directory)) return {recovered};
    for(const name of await fs.readdir(directory)) {
      if(!/^move-[a-f0-9-]+\.json$/.test(name)) continue;
      const path=join(directory,name), record=JSON.parse(await fs.readFile(path,'utf8'));
      if(record.bindingId!==b.id||record.phase==='completed'||record.phase==='cancelled') continue;
      const head=await this.head(b);
      if(head===record.old) { await atomicJson(path,{...record,phase:'cancelled'}); continue; }
      if(head!==record.next) fail('RECOVERY_REQUIRED','Repository moved during interrupted operation');
      // Validate the actual old/new worktree mixture before changing any files,
      // then reinstall every desired file, including missing unchanged files.
      await this.materialize(b,record.old,record.next,true);
      await this.clean(b); await atomicJson(path,{...record,phase:'completed'}); recovered++;
    }
    for(const name of await fs.readdir(directory)) {
      if(!/^commit-[\w-]+\.json$/.test(name)) continue;
      const path=join(directory,name), record=JSON.parse(await fs.readFile(path,'utf8'));
      if(record.bindingId!==b.id||record.phase==='completed') continue;
      // An accepted-only receipt has no durable commit intent; any unreachable object
      // created before a crash is deliberately not published or recreated.
      if(record.phase==='accepted') {
        const result:GitCommitResult={sha:record.old,committed:false,pushed:false,remoteState:'not-pushed'};
        await atomicJson(path,{...record,phase:'completed',result}); recovered++; continue;
      }
      const sha=record.sha as string|null;
      if(sha!==null && !SHA.test(sha)) fail('RECOVERY_REQUIRED','Invalid commit recovery record');
      let head=await this.head(b);
      if(head===record.old && sha!==head && sha) { await this.move(b,head,sha); head=sha; }
      if(head!==sha) fail('RECOVERY_REQUIRED','External branch change blocks commit receipt recovery');
      await this.clean(b);
      let result:GitCommitResult={sha,committed:sha!==record.old,pushed:false,remoteState:'not-pushed',...(record.backupRef?{backupRef:record.backupRef}:{})};
      if(record.push&&sha) {
        // A push may have reached the server before the process died. Observe the
        // remote before reporting success; never create a second commit or force push.
        try {
          await this.fetchInternal(b); const remote=await this.ref(b,this.remoteRef(b));
          let contained=false;
          if(remote) { try { await this.git(b.repositoryPath,['merge-base','--is-ancestor',sha,remote]); contained=true; } catch(e) { if(!(e instanceof GitRepositoryError)||e.code!=='GIT_FAILED') throw e; } }
          result={...result,pushed:contained,remoteState:contained?'confirmed':'not-pushed'};
        } catch(e) { result={...result,remoteState:'unknown',pushError:e instanceof GitRepositoryError?e.code:'REMOTE_UNKNOWN'}; }
      }
      await atomicJson(path,{...record,phase:'completed',result}); recovered++;
    }
    return {recovered};
  }); }
  async unbind() {return this.exclusive(async()=>{const b=await this.binding();await atomicJson(join(this.root,'binding.json'),null);this.previews.clear();return {bindingId:b.id,repositoryPath:b.repositoryPath,retained:true};});}
}
