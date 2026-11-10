import { mkdir, chmod, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { git } from "./git.js";
import type { ProjectSource } from "./types.js";

/** Reject unsafe and platform-ambiguous trees before writing any source files. */
export function treeEntries(tree: Buffer) {
  const seen = new Map<string, string>(), entries: { mode: string; sha: string; path: string }[] = [];
  for (const raw of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(raw);
    check(match, "PROJECT_TREE_INVALID", "Git tree 格式无效");
    const [, mode, sha, path] = match as unknown as [string, string, string, string];
    const components = path.split("/");
    check(!path.includes("\ufffd") && components.every(p => p && p !== "." && p !== ".." && !/[\\:\x00-\x1f\x7f]/.test(p) && !/[. ]$/.test(p) && !/^(?:\.git|\.hg|\.svn)$/i.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), "PROJECT_TREE_INVALID", "仓库包含不安全或不兼容路径");
    for (let n = 1; n <= components.length; n++) {
      const prefix = components.slice(0, n).join("/"), folded = prefix.normalize("NFC").toLowerCase();
      const previous = seen.get(folded);
      check(!previous || previous === prefix, "PROJECT_TREE_INVALID", "仓库存在大小写或 Unicode 路径冲突");
      seen.set(folded, prefix);
    }
    entries.push({ mode, sha, path });
  }
  return entries;
}
export async function materialize(cache: string, sha: string, destination: string, signal: AbortSignal, env: Record<string, string> = {}): Promise<NonNullable<ProjectSource["unexpanded"]>> {
  const entries = treeEntries(await git(cache, ["ls-tree", "-rz", "--full-tree", sha], signal, env));
  const unexpanded = { symlinks: 0, submodules: 0, lfs: 0 };
  for (const entry of entries) {
    signal.throwIfAborted();
    if (entry.mode === "120000") { unexpanded.symlinks++; continue; }
    if (entry.mode === "160000") { unexpanded.submodules++; continue; }
    check(entry.mode === "100644" || entry.mode === "100755", "PROJECT_TREE_INVALID", "Git tree 文件类型不支持");
    const path = join(destination, entry.path);
    try { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); }
    catch { throw new AppError("PROJECT_IO_FAILED", "无法创建源码目录"); }
    await git(cache, ["cat-file", "blob", entry.sha], signal, env, path);
    if (entry.mode === "100755") await chmod(path, 0o700);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(200); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).toString().startsWith("version https://git-lfs.github.com/spec/v1\n")) unexpanded.lfs++;
    } finally { await handle.close(); }
  }
  return unexpanded;
}
