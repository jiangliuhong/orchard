import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, opendirSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, check } from "../domain/errors.js";
import { parseConfigJson } from "../migrations/config.js";

export const KNOWLEDGE_FORMAT_VERSION = 1;
export const KNOWLEDGE_BUNDLE_VERSION = "2026.11.11.2";
export const KNOWLEDGE_CONTRACT_VERSION = "unified-agent-v1";
export const KNOWLEDGE_TOOL_POLICY_VERSION = "platform-read-v1";
export const PLATFORM_READ_TOOL_NAMES = Object.freeze(["assets.search", "workflows.get", "scripts.get", "assets.read_file", "bridge_tools.get", "assets.references", "current.get", "current.selected_test"] as const);
export const KNOWLEDGE_PROFILES = freeze({
  workflow: { skill: ".agents/skills/workflow-authoring/SKILL.md", documents: ["docs/workflow.md"] },
  script: { skill: ".agents/skills/script-authoring/SKILL.md", documents: ["docs/script.md"] },
  "web-bridge": { skill: ".agents/skills/web-bridge-authoring/SKILL.md", documents: ["docs/web-bridge.md"] },
} as const);
export type KnowledgeProfile = keyof typeof KNOWLEDGE_PROFILES;
export const REQUIRED_KNOWLEDGE_FILES = Object.freeze(["AGENTS.md", ".agents/mcp.json", ...Object.values(KNOWLEDGE_PROFILES).flatMap(profile => [profile.skill, ...profile.documents])]);
const MAX_FILES = 64, MAX_FILE_BYTES = 1024 * 1024, MAX_BUNDLE_BYTES = 4 * 1024 * 1024, MAX_MANIFEST_BYTES = 64 * 1024;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => { throw new AppError("KNOWLEDGE_BUNDLE_INVALID", message, 503); };

export interface KnowledgeManifest {
  formatVersion: 1;
  bundleVersion: string;
  contractVersion: string;
  toolPolicyVersion: string;
  profiles: Record<KnowledgeProfile, { skill: string; documents: string[] }>;
  files: { path: string; bytes: number; sha256: string }[];
}
export interface KnowledgeBundle {
  readonly manifest: Readonly<KnowledgeManifest>;
  readonly manifestText: string;
  readonly hash: string;
  /** Immutable UTF-8 strings; callers cannot mutate validated Buffer contents. */
  readonly files: Readonly<Record<string, string>>;
}
export function installedKnowledgeDirectory(): string { return fileURLToPath(new URL("./knowledge/", import.meta.url)); }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), "KNOWLEDGE_BUNDLE_INVALID", "知识声明字段无效", 503);
  return value as Record<string, unknown>;
}
function parse(text: string): unknown {
  try { return parseConfigJson(text); } catch { return fail("知识 JSON 无效或存在重复键"); }
}
function path(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length <= 200 && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === "..") && (
    value === "AGENTS.md" || value === ".agents/mcp.json" || /^docs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md$/.test(value) ||
    Object.values(KNOWLEDGE_PROFILES).some(profile => value === profile.skill || (value.startsWith(posix.dirname(profile.skill) + "/docs/") && /^\.agents\/skills\/[a-z-]+\/docs\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.md$/.test(value)))
  ), "KNOWLEDGE_BUNDLE_INVALID", "知识路径不在受控资源范围内", 503);
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("知识资源不是合法 UTF-8"); }
}
function readBounded(file: string, limit: number): Buffer {
  const before = lstatSync(file);
  check(before.isFile() && !before.isSymbolicLink() && before.size <= limit, "KNOWLEDGE_BUNDLE_INVALID", "知识资源类型或大小无效", 503);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    check(opened.dev === before.dev && opened.ino === before.ino, "KNOWLEDGE_BUNDLE_INVALID", "知识资源在读取时变化", 503);
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) { const n = readSync(fd, buffer, size, buffer.length - size, null); if (!n) break; size += n; }
    const after = fstatSync(fd), latest = lstatSync(file);
    check(size <= limit && size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && latest.dev === opened.dev && latest.ino === opened.ino && !latest.isSymbolicLink(), "KNOWLEDGE_BUNDLE_INVALID", "知识资源超过预算或读取期间变化", 503);
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
/** Also rejects unexpected directories/links; do not use a manifest as arbitrary path read authority. */
function scan(root: string): { files: string[]; directories: string[] } {
  check(isAbsolute(root) && realpathSync(root) === root && lstatSync(root).isDirectory(), "KNOWLEDGE_BUNDLE_INVALID", "知识根目录必须是无符号链接的绝对目录", 503);
  const files: string[] = [], directories: string[] = [];
  const visit = (directory: string, depth: number) => {
    check(depth <= 8 && directories.length <= 128, "KNOWLEDGE_BUNDLE_INVALID", "知识目录超过预算", 503);
    const handle = opendirSync(join(root, directory));
    try { for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name, info = lstatSync(join(root, relative));
      check(!info.isSymbolicLink(), "KNOWLEDGE_BUNDLE_INVALID", "知识目录包含符号链接", 503);
      if (info.isDirectory()) { directories.push(relative); visit(relative, depth + 1); }
      else {
        check(info.isFile(), "KNOWLEDGE_BUNDLE_INVALID", "知识目录包含非常规文件", 503);
        if (relative !== "manifest.json") path(relative);
        files.push(relative);
        check(files.length <= MAX_FILES + 1, "KNOWLEDGE_BUNDLE_INVALID", "知识文件数量超过预算", 503);
      }
    } } finally { handle.closeSync(); }
  };
  visit("", 0);
  return { files: files.sort(), directories: directories.sort() };
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function validateManifest(value: unknown): KnowledgeManifest {
  const manifest = object(value, ["formatVersion", "bundleVersion", "contractVersion", "toolPolicyVersion", "profiles", "files"]);
  check(manifest.formatVersion === KNOWLEDGE_FORMAT_VERSION && typeof manifest.bundleVersion === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(manifest.bundleVersion) && manifest.contractVersion === KNOWLEDGE_CONTRACT_VERSION && manifest.toolPolicyVersion === KNOWLEDGE_TOOL_POLICY_VERSION,
    "KNOWLEDGE_BUNDLE_INVALID", "知识格式或执行契约版本不兼容", 503);
  const profiles = object(manifest.profiles, Object.keys(KNOWLEDGE_PROFILES));
  for (const [id, expected] of Object.entries(KNOWLEDGE_PROFILES)) {
    const profile = object(profiles[id], ["skill", "documents"]);
    check(profile.skill === expected.skill && Array.isArray(profile.documents) && JSON.stringify(profile.documents) === JSON.stringify(expected.documents), "KNOWLEDGE_BUNDLE_INVALID", "知识 profile 不匹配", 503);
  }
  check(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= MAX_FILES, "KNOWLEDGE_BUNDLE_INVALID", "知识文件清单无效", 503);
  const seen = new Set<string>(); let total = 0;
  for (const raw of manifest.files) {
    const file = object(raw, ["path", "bytes", "sha256"]); path(file.path);
    check(!seen.has(file.path) && Number.isSafeInteger(file.bytes) && Number(file.bytes) > 0 && Number(file.bytes) <= MAX_FILE_BYTES && typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256), "KNOWLEDGE_BUNDLE_INVALID", "知识文件重复、超限或摘要无效", 503);
    seen.add(file.path); total += Number(file.bytes);
  }
  check(total <= MAX_BUNDLE_BYTES && REQUIRED_KNOWLEDGE_FILES.every(file => seen.has(file)), "KNOWLEDGE_BUNDLE_INVALID", "知识总大小超限或缺少必需文件", 503);
  return manifest as unknown as KnowledgeManifest;
}
function validateTools(text: string): void {
  const config = object(parse(text), ["formatVersion", "policyVersion", "transport", "tools"]);
  check(config.formatVersion === 1 && config.policyVersion === KNOWLEDGE_TOOL_POLICY_VERSION && config.transport === "provider-managed" && JSON.stringify(config.tools) === JSON.stringify(PLATFORM_READ_TOOL_NAMES), "KNOWLEDGE_BUNDLE_INVALID", "平台工具声明必须只包含固定只读能力，不允许凭据、进程或外部传输配置", 503);
}
function validateDirectories(directories: string[], files: string[]): void {
  const expected = new Set<string>();
  for (const file of files) { let parent = posix.dirname(file); while (parent !== ".") { expected.add(parent); parent = posix.dirname(parent); } }
  check(directories.every(directory => expected.has(directory)), "KNOWLEDGE_BUNDLE_INVALID", "知识包含未声明或空的额外目录", 503);
}

// Preserve the original generated byte layout as the hash input so existing
// installations and sessions keep their knowledge identity.
function serializeManifest(manifest: KnowledgeManifest): string {
  const { formatVersion, bundleVersion, contractVersion, toolPolicyVersion } = manifest;
  const files = manifest.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return JSON.stringify({ formatVersion, bundleVersion, contractVersion, toolPolicyVersion, profiles: KNOWLEDGE_PROFILES, files }, null, 2) + "\n";
}

export function generateSourceKnowledgeBundle(root: string, bundleVersion = KNOWLEDGE_BUNDLE_VERSION): KnowledgeBundle {
  check(isAbsolute(root), "KNOWLEDGE_BUNDLE_INVALID", "知识根目录必须是绝对路径", 503);
  root = resolve(root);
  const entries = scan(root), records: KnowledgeManifest["files"] = [];
  const files: Record<string, string> = Object.create(null);
  let total = 0;
  for (const relative of entries.files.filter(file => file !== "manifest.json")) {
    const bytes = readBounded(join(root, relative), MAX_FILE_BYTES);
    total += bytes.length;
    check(total <= MAX_BUNDLE_BYTES, "KNOWLEDGE_BUNDLE_INVALID", "知识资源总大小超限", 503);
    files[relative] = utf8(bytes);
    records.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
  }
  validateDirectories(entries.directories, records.map(file => file.path));
  const manifest = validateManifest({ formatVersion: 1, bundleVersion, contractVersion: KNOWLEDGE_CONTRACT_VERSION, toolPolicyVersion: KNOWLEDGE_TOOL_POLICY_VERSION, profiles: KNOWLEDGE_PROFILES, files: records });
  validateTools(files[".agents/mcp.json"]!);
  const manifestText = serializeManifest(manifest);
  return Object.freeze({ manifest: freeze(manifest), manifestText, hash: sha(manifestText), files: Object.freeze(files) });
}

export function createKnowledgeManifest(root: string, bundleVersion: string): KnowledgeManifest {
  return generateSourceKnowledgeBundle(root, bundleVersion).manifest;
}

export function loadKnowledgeBundle(root?: string): KnowledgeBundle {
  if (root === undefined && import.meta.url.endsWith(".ts")) return generateSourceKnowledgeBundle(installedKnowledgeDirectory());
  root ??= installedKnowledgeDirectory();
  // Normalize a module file URL's trailing separator without making relative/cwd-based paths valid.
  check(isAbsolute(root), "KNOWLEDGE_BUNDLE_INVALID", "知识根目录必须是绝对路径", 503);
  root = resolve(root);
  const entries = scan(root);
  const manifest = validateManifest(parse(utf8(readBounded(join(root, "manifest.json"), MAX_MANIFEST_BYTES))));
  const manifestText = serializeManifest(manifest), names = manifest.files.map(file => file.path).sort();
  check(JSON.stringify(entries.files) === JSON.stringify([...names, "manifest.json"].sort()), "KNOWLEDGE_BUNDLE_INVALID", "安装包知识文件与声明不一致", 503);
  validateDirectories(entries.directories, names);
  const files: Record<string, string> = Object.create(null);
  for (const file of manifest.files) {
    const bytes = readBounded(join(root, file.path), MAX_FILE_BYTES);
    check(bytes.length === file.bytes && sha(bytes) === file.sha256, "KNOWLEDGE_BUNDLE_INVALID", "知识文件字节或哈希不匹配", 503);
    files[file.path] = utf8(bytes);
  }
  validateTools(files[".agents/mcp.json"]!);
  return Object.freeze({ manifest: freeze(manifest), manifestText, hash: sha(manifestText), files: Object.freeze(files) });
}
