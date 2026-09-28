import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";

export interface ArtifactRef {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly hash: string;
  readonly mime: string;
}

export interface PublishedArtifact {
  readonly rootPath: string;
  readonly relativePath: string;
  readonly manifestPath: string;
  readonly sourceTreeHash: string;
  readonly bundleHash: string;
}

export interface ArtifactReconciliation {
  readonly missing: readonly string[];
  readonly candidates: readonly string[];
}

function digest(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }
function safeSegment(value: string): void { if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") throw new Error(`Unsafe artifact path segment: ${value}`); }

export class ArtifactStore {
  readonly root: string;
  constructor(dataDir: string) { this.root = resolve(dataDir, "artifacts"); }

  async saveJson(input: { runId: string; stepId?: string; attemptId?: string; value: unknown; maxBytes?: number }): Promise<ArtifactRef> {
    const serialized = JSON.stringify(input.value);
    if (serialized === undefined) throw new Error("Artifact value must be JSON serializable");
    const content = Buffer.from(serialized, "utf8");
    const maxBytes = input.maxBytes ?? 50 * 1024 * 1024;
    if (content.byteLength > maxBytes) throw new Error(`Artifact exceeds ${maxBytes} bytes`);
    const id = uuidv7();
    const runDir = resolve(this.root, input.runId);
    if (!this.isInside(this.root, runDir)) throw new Error("Artifact run id escaped storage root");
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    const managedRoot = await realpath(this.root);
    const actualDir = await realpath(runDir);
    if (!this.isInside(managedRoot, actualDir)) throw new Error("Artifact run id escaped storage root");
    const path = join(actualDir, `${id}.json`);
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    return { id, path, size: content.byteLength, hash: createHash("sha256").update(content).digest("hex"), mime: "application/json" };
  }

  /** Publish a complete immutable workflow artifact using temp-dir + rename. */
  async publishWorkflowVersion(input: { appId: string; workflowId: string; versionId: string; sourceDir: string; bundlePath: string; manifest: Record<string, unknown> }): Promise<PublishedArtifact> {
    for (const segment of [input.appId, input.workflowId, input.versionId]) safeSegment(segment);
    const operation = join(resolve(this.root, ".."), "tmp", `publish-${uuidv7()}`);
    const destination = join(this.root, input.appId, input.workflowId, input.versionId);
    await mkdir(operation, { recursive: true, mode: 0o700 });
    try {
      await cp(input.sourceDir, join(operation, "source"), { recursive: true, force: false, verbatimSymlinks: true });
      await mkdir(join(operation, "bundle"), { recursive: true, mode: 0o700 });
      await cp(input.bundlePath, join(operation, "bundle", "worker.mjs"), { force: false });
      const bundle = await readFile(join(operation, "bundle", "worker.mjs"));
      const files = await this.fileManifest(join(operation, "source"));
      const sourceTreeHash = digest(Buffer.from(JSON.stringify(files)));
      const bundleHash = digest(bundle);
      const manifest = { ...input.manifest, entry: "source/worker.ts", files: files.map((file) => `source/${file.path}`), sourceTreeHash, bundleHash };
      await writeFile(join(operation, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
      await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
      await rename(operation, destination);
      return { rootPath: destination, relativePath: relative(resolve(this.root, ".."), destination), manifestPath: join(destination, "manifest.json"), sourceTreeHash, bundleHash };
    } catch (error) {
      await rm(operation, { recursive: true, force: true });
      throw error;
    }
  }

  /** Find registered artifact paths that disappeared and unregistered directories. */
  async reconcile(referenced: ReadonlySet<string>): Promise<ArtifactReconciliation> {
    const missing: string[] = [];
    for (const path of referenced) {
      const absolute = resolve(this.root, "..", path);
      try { await stat(absolute); } catch { missing.push(path); }
    }
    const candidates: string[] = [];
    for (const app of await this.safeReadDir(this.root)) for (const workflow of await this.safeReadDir(join(this.root, app))) for (const version of await this.safeReadDir(join(this.root, app, workflow))) {
      const path = relative(resolve(this.root, ".."), join(this.root, app, workflow, version));
      if (!referenced.has(path)) candidates.push(path);
    }
    return { missing, candidates };
  }

  /** Record a directory that was moved before its metadata transaction failed. */
  async markOrphanCandidate(path: string): Promise<void> {
    const candidateFile = join(resolve(this.root, ".."), "tmp", "orphan-candidates.json");
    let candidates: Record<string, number> = {};
    try { candidates = JSON.parse(await readFile(candidateFile, "utf8")) as Record<string, number>; } catch { /* first candidate */ }
    candidates[path] = Date.now();
    await writeFile(candidateFile, JSON.stringify(candidates), { mode: 0o600 });
  }

  /** Remove only unreferenced artifact directories older than the grace period. */
  async garbageCollect(referenced: ReadonlySet<string>, graceMs = 24 * 60 * 60 * 1000, nowMs = Date.now()): Promise<string[]> {
    const removed: string[] = [];
    for (const app of await this.safeReadDir(this.root)) for (const workflow of await this.safeReadDir(join(this.root, app))) for (const version of await this.safeReadDir(join(this.root, app, workflow))) {
      const path = join(this.root, app, workflow, version);
      const relativePath = relative(resolve(this.root, ".."), path);
      if (referenced.has(relativePath)) continue;
      const info = await stat(path);
      if (nowMs - info.mtimeMs < graceMs) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(relativePath);
    }
    return removed;
  }

  private async safeReadDir(path: string): Promise<string[]> { try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; } }
  private async fileManifest(root: string): Promise<readonly { path: string; hash: string; size: number }[]> {
    const result: { path: string; hash: string; size: number }[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in artifact source: ${entry.name}`);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) { const content = await readFile(path); result.push({ path: relative(root, path), hash: digest(content), size: content.byteLength }); }
        else throw new Error(`Unsupported artifact entry: ${entry.name}`);
      }
    };
    await visit(root);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(ref: ArtifactRef): Promise<Buffer> {
    const root = await realpath(this.root);
    const path = await realpath(ref.path);
    if (!this.isInside(root, path) || !path.endsWith(`/${ref.id}.json`)) throw new Error("Artifact path is outside the managed store");
    const content = await readFile(path);
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== ref.hash) throw new Error("Artifact hash mismatch");
    return content;
  }

  private isInside(root: string, target: string): boolean {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return target === root || target.startsWith(prefix);
  }
}
