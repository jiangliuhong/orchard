import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseSnapshot, refreshManifest } from "./snapshot.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 10000;
function fail(message: string): never { throw Object.assign(new Error(message), { code: "CONFIG_GIT_INVALID_INPUT" }); }
function safeRelative(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || isAbsolute(path) || /[\\\x00-\x1f\x7f:]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) fail("Invalid relative configuration path");
}
function checkDirectory(path: string) {
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Configuration directory and its ancestors must be real directories");
  }
}
function readRegular(path: string, maxBytes = MAX_BYTES): string {
  checkDirectory(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail("Snapshot entries must be regular files within size limits");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) fail("Snapshot file changed during validation");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - length + 1));
      const count = readSync(fd, chunk);
      if (!count) break;
      length += count;
      if (length > maxBytes) fail("Snapshot exceeds size limit");
      chunks.push(chunk.subarray(0, count));
    }
    const data = Buffer.concat(chunks, length);
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { return fail("Snapshot files must contain valid UTF-8"); }
  } finally { closeSync(fd); }
}

/** Read only an explicit snapshot directory, never execute its configuration. */
export function readSnapshotDirectory(directory: string): Record<string, string> {
  if (directory.split(/[\\/]/).includes("..")) fail("Directory traversal is not allowed");
  const root = resolve(directory);
  checkDirectory(root);
  const files: Record<string, string> = Object.create(null);
  let bytes = 0, entries = 0, fileCount = 0;
  function visit(relative: string) {
    if (relative.split("/").length > 100) fail("Snapshot directory nesting exceeds limit");
    const path = relative ? join(root, relative) : root;
    checkDirectory(path);
    for (const entry of readdirSync(path).sort()) {
      const child = relative ? `${relative}/${entry}` : entry;
      safeRelative(child);
      if (++entries > MAX_FILES * 2) fail("Snapshot has too many directory entries");
      const stat = lstatSync(join(root, child));
      if (stat.isSymbolicLink()) fail("Symbolic links are not allowed in snapshots");
      if (stat.isDirectory()) visit(child);
      else {
        if (++fileCount > MAX_FILES) fail("Snapshot has too many files");
        const text = readRegular(join(root, child), MAX_BYTES - bytes);
        bytes += Buffer.byteLength(text);
        files[child] = text;
      }
    }
  }
  visit("");
  return files;
}

export function snapshotDirectory(dataDir: string, explicit?: string): string {
  if (explicit !== undefined) {
    if (!explicit || explicit.split(/[\\/]/).includes("..")) fail("Invalid explicit directory");
    return resolve(explicit);
  }
  const binding = JSON.parse(readRegular(join(resolve(dataDir), "config-git", "binding.json"), 1024 * 1024));
  if (!binding || typeof binding !== "object") fail("No configuration repository is bound; specify --directory");
  safeRelative(binding.id);
  if (binding.id.includes("/")) fail("Invalid binding ID");
  safeRelative(binding.configDir);
  return join(resolve(dataDir), "config-git", "repositories", binding.id, binding.configDir);
}

export function validateSnapshotDirectory(directory: string, refresh = false) {
  const files = readSnapshotDirectory(directory);
  if (!refresh) {
    parseSnapshot(files);
    return { valid: true, refreshed: false, directory: resolve(directory), fileCount: Object.keys(files).length };
  }
  const bundle = refreshManifest(files);
  // Recheck the complete input before replacing only the manifest.
  const current = readSnapshotDirectory(directory);
  if (JSON.stringify(current) !== JSON.stringify(files)) fail("Snapshot changed during validation; retry");
  const root = resolve(directory);
  const temp = join(root, `.manifest-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { writeFileSync(fd, bundle.files["manifest.json"], "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    checkDirectory(root);
    renameSync(temp, join(root, "manifest.json"));
    created = false;
    const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { if (created) unlinkSync(temp); }
  return { valid: true, refreshed: true, directory: root, fileCount: Object.keys(bundle.files).length, digest: bundle.digest };
}

export const configGitHelp = `orchard config-git validate [--directory <snapshot-dir>] [--refresh-manifest]
orchard config-git status|repository|history|recovery-points
orchard config-git remote-check --remote-url <ssh-or-https-url>
orchard config-git bind --remote-url <url> --branch <branch> [--config-dir <path>] [--name <name> --email <email>]
orchard config-git unbind [--request-id <id>]
orchard config-git export [--theme light|dark|system]
orchard config-git commit-preview --message <text> [--push] [--regenerate] [--theme <theme>]
orchard config-git commit --token <preview-token> [--request-id <id>] [--theme <theme>]
orchard config-git fetch|push [--request-id <id>]
orchard config-git restore-preview (--sha <sha> | --recovery-point <id>) --categories <comma-separated> [--mappings-json <json>]
orchard config-git restore --token <preview-token> [--request-id <id>]
orchard config-git operation|recover --id <operation-id>
Server commands use --server-url, --data-dir and --pretty. Reuse --request-id when retrying a write.`;

type Context = { dataDir: string; request: (path: string, init?: RequestInit) => Promise<unknown>; output: (value: unknown) => void };
export async function runConfigGitCli(args: string[], context: Context) {
  const command = args[0];
  const commandOptions: Record<string, string[]> = {
    validate: ["directory", "refresh-manifest"], status: [], repository: [], "recovery-points": [],
    history: ["cursor", "limit", "start-sha"], commits: ["cursor", "limit", "start-sha"], operation: ["id"],
    export: ["theme"], "commit-preview": ["message", "push", "regenerate", "theme"],
    commit: ["token", "request-id", "theme"], confirm: ["token", "request-id", "theme"],
    "remote-sync-source": ["request-id"], fetch: ["request-id"], push: ["request-id"], unbind: ["request-id"], recover: ["id", "request-id"],
    "remote-check": ["remote-url"], bind: ["remote-url", "branch", "config-dir", "name", "email", "request-id"],
    "restore-preview": ["sha", "recovery-point", "categories", "mappings-json"], restore: ["token", "request-id"],
  };
  if (!commandOptions[command]) fail("Unknown config-git command; use orchard --help");
  const allowed = new Set([...commandOptions[command], "port", "server-url", "data-dir", "pretty"].map(name => `--${name}`));
  const flags = new Set(["--pretty", "--refresh-manifest", "--push", "--regenerate"]);
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (!allowed.has(name) || seen.has(name)) fail("Unknown or repeated config-git option");
    seen.add(name);
    if (!flags.has(name)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) fail(`Missing value for ${name}`);
      i++;
    }
  }
  function option(name: string, required = false): string | undefined {
    const index = args.indexOf(name);
    if (index < 0) { if (required) fail(`Missing ${name}`); return undefined; }
    if (!args[index + 1] || args[index + 1].startsWith("--")) fail(`Missing value for ${name}`);
    return args[index + 1];
  }
  const theme = option("--theme");
  if (theme && !["light", "dark", "system"].includes(theme)) fail("Invalid theme");
  const requestId = () => option("--request-id") ?? randomUUID();
  const post = (path: string, body: unknown) => context.request(`/api/config-git/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (command === "validate") return context.output(validateSnapshotDirectory(snapshotDirectory(context.dataDir, option("--directory")), args.includes("--refresh-manifest")));
  if (["status", "repository", "recovery-points"].includes(command)) return context.request(`/api/config-git/${command}`);
  if (command === "history" || command === "commits") {
    const query = new URLSearchParams();
    for (const key of ["cursor", "limit", "start-sha"]) { const value = option(`--${key}`); if (value) query.set(key === "start-sha" ? "startSha" : key, value); }
    return context.request(`/api/config-git/commits${query.size ? `?${query}` : ""}`);
  }
  if (command === "operation") return context.request(`/api/config-git/operations/${encodeURIComponent(option("--id", true)!)}`);
  if (command === "remote-check") return post("remote/check", { remoteUrl: option("--remote-url", true) });
  if (command === "bind") {
    const name = option("--name"), email = option("--email");
    if (Boolean(name) !== Boolean(email)) fail("Specify both --name and --email for commit identity");
    return post("bind", { remoteUrl: option("--remote-url", true), branch: option("--branch", true), configDir: option("--config-dir"), identity: name ? { name, email } : undefined, requestId: requestId() });
  }
  if (command === "unbind") return post(command, { requestId: requestId() });
  if (command === "recover") return post(`operations/${encodeURIComponent(option("--id", true)!)}/recover`, { requestId: requestId() });
  if (command === "export") return post("export", { theme });
  if (command === "remote-sync-source" || command === "fetch" || command === "push") return post(command, { requestId: requestId() });
  if (command === "commit-preview") return post(command, { message: option("--message", true), push: args.includes("--push"), regenerate: args.includes("--regenerate"), theme });
  if (command === "commit" || command === "confirm" || command === "restore") return post(command === "confirm" ? "commit" : command, { token: option("--token", true), requestId: requestId(), ...(command === "restore" ? {} : { theme }) });
  if (command === "restore-preview") {
    const sha = option("--sha"), recoveryPoint = option("--recovery-point");
    if (Boolean(sha) === Boolean(recoveryPoint)) fail("Specify exactly one of --sha and --recovery-point");
    const categories = option("--categories", true)!.split(",");
    if (!categories.length || categories.some(c => !["general", "providers", "webBridge", "workflows", "scripts", "dictionaries"].includes(c)) || new Set(categories).size !== categories.length) fail("Invalid restore categories");
    let mappings: unknown;
    try { mappings = JSON.parse(option("--mappings-json") ?? "{}"); } catch { fail("Invalid mappings JSON"); }
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings) || Object.values(mappings).some(v => typeof v !== "string")) fail("Mappings must be a JSON object of strings");
    return post(command, { source: sha ? { kind: "git", sha } : { kind: "recovery-point", id: recoveryPoint }, categories, mappings });
  }
  fail("Unknown config-git command; use orchard --help");
}
