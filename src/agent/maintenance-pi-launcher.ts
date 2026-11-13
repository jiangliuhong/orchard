import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { check } from "../domain/errors.js";
import { digest } from "../persistence/files.js";
import type { PrivateMaintenanceBridge } from "./maintenance-ipc.js";
import type { MaintenanceProcessRegistry, MaintenanceProcessLease } from "./maintenance-processes.js";

interface VerifiedEntry {
  path: string;
  sha256: string;
}

function verifiedEntry(entry: VerifiedEntry): string {
  check(isAbsolute(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256),
    "MAINTENANCE_PACKAGE_INVALID", "维护启动入口缺少可信摘要", 503);
  const stat = lstatSync(entry.path);
  check(stat.isFile() && realpathSync(entry.path) === entry.path && stat.size <= 128 * 1024 * 1024 &&
    digest(readFileSync(entry.path)) === entry.sha256,
    "MAINTENANCE_PACKAGE_INVALID", "维护启动入口完整性检查失败", 503);
  return entry.path;
}

type NativeSession = { directory: string; id: string; resumeFile?: string };
interface LaunchOptions {
  registry: MaintenanceProcessRegistry;
  lease: MaintenanceProcessLease;
  bridge: PrivateMaintenanceBridge;
  pi: VerifiedEntry;
  extension: VerifiedEntry;
  helper: VerifiedEntry;
  workspace: string;
  privateHome: string;
  agentDir: string;
  model?: string;
}

function nativeArgs(session: NativeSession | undefined, workspace: string): string[] {
  if (!session) return ["--no-session"];
  check(isAbsolute(session.directory) && realpathSync(session.directory) === session.directory &&
    lstatSync(session.directory).isDirectory() && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(session.id),
  "BACKEND_REFERENCE_INVALID", "Pi 原生会话目录或标识无效", 409);
  if (!session.resumeFile) return ["--session-dir", session.directory, "--session-id", session.id];
  assertNativeMaintenanceSession(session.resumeFile, session.directory, session.id, workspace);
  return ["--session", session.resumeFile];
}

export function assertNativeMaintenanceSession(file: string, directory: string, id: string, workspace: string) {
  check(isAbsolute(file) && dirname(file) === directory && realpathSync(file) === file && file.endsWith(".jsonl"),
    "BACKEND_REFERENCE_INVALID", "Pi 原生会话文件不在受管目录内", 409);
  const stat = lstatSync(file);
  check(stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024 * 1024,
    "BACKEND_REFERENCE_INVALID", "Pi 原生会话文件身份或大小无效", 409);
  let header: unknown;
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    check(opened.dev === stat.dev && opened.ino === stat.ino && opened.nlink === 1 && opened.size === stat.size,
      "BACKEND_REFERENCE_INVALID", "Pi 原生会话文件已变化", 409);
    const bytes = Buffer.alloc(65536);
    const head = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0));
    const newline = head.indexOf(10);
    if (newline >= 0) {
      try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, newline))); } catch { /* Reject below. */ }
    }
  } finally { closeSync(fd); }
  check(header && typeof header === "object" && "type" in header && header.type === "session" && "id" in header && header.id === id && "cwd" in header && header.cwd === workspace,
    "BACKEND_REFERENCE_INVALID", "Pi 原生会话文件标识与保存引用不一致", 409);
}

export function launchMaintenancePiSingle(options: LaunchOptions) {
  return launchMaintenancePi(options);
}

/** Entry hashes come from trusted release metadata. The host owns session
 * directories, checks the returned RPC identity and certifies its backend. */
export async function launchMaintenancePi(options: LaunchOptions, session?: NativeSession) {
  const { registry, lease, bridge } = options;
  try {
    const piEntry = verifiedEntry(options.pi);
    const extension = verifiedEntry(options.extension);
    const helperEntry = verifiedEntry(options.helper);
    check([options.workspace, options.privateHome, options.agentDir].every(path => isAbsolute(path) && realpathSync(path) === path),
      "MAINTENANCE_PACKAGE_INVALID", "维护运行目录无效", 503);
    check(options.model === undefined || /^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}$/.test(options.model),
      "BACKEND_UNAVAILABLE", "维护模型标识无效", 503);
    const sessionArgs = nativeArgs(session, options.workspace);
    const env = { HOME: options.privateHome, PI_CODING_AGENT_DIR: options.agentDir, ...(options.model ? {} : { PI_OFFLINE: "1" }) };
    const helper = registry.launch(lease, { entry: helperEntry, cwd: options.privateHome, env, privatePipes: 1 });
    const pi = registry.launch(lease, {
      entry: piEntry, cwd: options.workspace, env, privatePipes: 3,
      args: ["--mode", "rpc", "--no-approve", ...sessionArgs, "--no-extensions", "--no-mcp", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "-e", extension,
        ...(options.model ? ["--model", options.model, "--thinking", "off"] : ["--offline"])],
    });
    const [readerBootstrap, mcpRequests, mcpReplies] = pi.privatePipes;
    mcpReplies!.on("error", () => { void bridge.close(); });
    helper.stdin.on("error", () => { void bridge.close(); });
    mcpRequests!.pipe(helper.stdin);
    helper.stdout.pipe(mcpReplies!);
    await Promise.all([
      bridge.writePrivateBootstrap("mcp", helper.privatePipes[0]!),
      bridge.writePrivateBootstrap("reader", readerBootstrap!),
    ]);
    return { pi, helper };
  } catch (error) {
    try { await bridge.close(); } finally { await registry.stop(lease); }
    throw error;
  }
}
