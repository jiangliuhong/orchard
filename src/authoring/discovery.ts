import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface DiscoveredWorkflow {
  readonly workspace: string;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly entry: "worker.ts";
}

function safeSegment(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}

function metadata(source: string, fallback: string): { name: string; description: string; id: string } {
  const id = source.match(/\bid\s*:\s*["']([^"']+)["']/)?.[1] ?? fallback;
  const name = source.match(/\bname\s*:\s*["']([^"']+)["']/)?.[1] ?? id;
  const description = source.match(/\bdescription\s*:\s*["']([^"']*)["']/)?.[1] ?? "";
  return { id, name, description };
}

/** Find source workflows without importing or executing user code. */
export async function discoverWorkflows(workspacesRoot: string): Promise<readonly DiscoveredWorkflow[]> {
  const root = resolve(workspacesRoot);
  const result: DiscoveredWorkflow[] = [];
  let workspaces;
  try { workspaces = await readdir(root, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() || !safeSegment(workspace.name)) continue;
    const workflowRoot = join(root, workspace.name, "workflows");
    let entries;
    try { entries = await readdir(workflowRoot, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !safeSegment(entry.name)) continue;
      const sourcePath = join(workflowRoot, entry.name);
      const workerPath = join(sourcePath, "worker.ts");
      try {
        const info = await lstat(workerPath);
        if (!info.isFile()) continue;
        const source = await readFile(workerPath, "utf8");
        const parsed = metadata(source, entry.name);
        result.push({ workspace: workspace.name, ...parsed, sourcePath, entry: "worker.ts" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return result.sort((a, b) => `${a.workspace}/${a.id}`.localeCompare(`${b.workspace}/${b.id}`));
}

export function relativeWorkflowPath(workspacesRoot: string, sourcePath: string): string {
  return relative(resolve(workspacesRoot), resolve(sourcePath)).split("\\").join("/");
}
