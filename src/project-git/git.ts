import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { AppError } from "../domain/errors.js";
import { safeGitError } from "./ssh.js";

/** Binary-safe Git plumbing. Blob output streams directly to disk, with no repository size quota. */
export async function git(cwd: string, args: string[], signal: AbortSignal, env: Record<string, string> = {}, outputFile?: string): Promise<Buffer> {
  signal.throwIfAborted();
  const { ORCHARD_PROJECT_PROCESS_DIR: processDirectory, ...childEnv } = env;
  const child = spawn("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", ...args], {
    cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", HOME: cwd, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "ssh", ...childEnv },
  });
  let processRecordWritten = false;
  const processRecord = processDirectory ? join(processDirectory, "process.json") : null;
  child.once("spawn", () => {
    if (processRecord) try { writeFileSync(processRecord, JSON.stringify({ pid: child.pid, ownerPid: process.pid, startedAt: Date.now() }), { flag: "wx", mode: 0o600 }); processRecordWritten = true; }
    catch { child.kill("SIGKILL"); }
  });
  let aborted = false, stderr = "";
  const chunks: Buffer[] = [];
  const kill = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { child.kill(sig); } };
  let force: ReturnType<typeof setTimeout> | undefined;
  const abort = () => { aborted = true; kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 300); force.unref(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stderr.on("data", (data: Buffer) => { if (stderr.length < 65536) stderr += data.toString("utf8"); });
  let streamError: unknown;
  const written = outputFile ? pipeline(child.stdout, createWriteStream(outputFile, { flags: "wx", mode: 0o600 })).catch(error => { streamError = error; kill("SIGTERM"); }) : Promise.resolve();
  if (!outputFile) child.stdout.on("data", (data: Buffer) => chunks.push(data));
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", () => reject(new AppError("PROJECT_FETCH_FAILED", "Git 无法启动"))); child.once("close", resolve); });
    await written;
    if (aborted) throw signal.reason instanceof AppError ? signal.reason : new AppError("CANCELLED", "项目准备已取消");
    if (processRecord && !processRecordWritten) throw new AppError("PROJECT_IO_FAILED", "无法记录 Git 进程租约");
    if (streamError) throw new AppError("PROJECT_IO_FAILED", "源码物化失败，请检查磁盘空间和文件权限");
    if (code !== 0) throw safeGitError(stderr);
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", abort); if (force) clearTimeout(force); if (processRecordWritten && processRecord) rmSync(processRecord, { force: true }); }
}
