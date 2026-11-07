import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Store } from "../persistence/store.js";
import { digest } from "../persistence/files.js";
import { check } from "../domain/errors.js";

export function syncFile(path: string) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function durableDirectory(store: Store, relative: string) {
  let current = "";
  for (const part of relative.split("/")) {
    current = current ? `${current}/${part}` : part;
    const path = store.files.path(current);
    if (!existsSync(path)) { mkdirSync(path, { mode: 0o700 }); syncFile(dirname(path)); }
  }
}
export function durableWrite(store: Store, relative: string, content: string) {
  const path = store.files.path(relative);
  durableDirectory(store, relative.slice(0, relative.lastIndexOf("/")));
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" }); syncFile(temp);
    renameSync(temp, path); syncFile(dirname(path));
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function durableJson(store: Store, relative: string, value: unknown) { durableWrite(store, relative, JSON.stringify(value)); }
export function readJson<T>(store: Store, relative: string): T { return JSON.parse(readFileSync(store.files.path(relative), "utf8")) as T; }
export function readOptional(store: Store, relative: string): string | null { const path = store.files.path(relative); return existsSync(path) ? readFileSync(path, "utf8") : null; }
export function persistArtifact(store: Store, reference: { path: string; hash: string }) {
  const path = store.files.path(reference.path);
  check(digest(readFileSync(path)) === reference.hash, "ARTIFACT_MISMATCH", "恢复产物摘要不一致");
  syncFile(path); syncFile(dirname(path)); syncFile(dirname(dirname(path))); syncFile(dirname(dirname(dirname(path)))); syncFile(store.root);
  return reference;
}
