import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { v7 as uuidv7 } from "uuid";

export interface ArtifactRef {
  readonly id: string;
  readonly path: string;
  readonly size: number;
  readonly hash: string;
  readonly mime: string;
}

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
