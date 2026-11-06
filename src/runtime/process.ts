import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AppError } from "../domain/errors.js";

export interface ProcessOptions {
  executable: string; args: string[]; cwd: string; input?: string; env?: Record<string, string>;
  signal?: AbortSignal; timeoutMs?: number; maxBytes?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => void;
  inheritEnv?: boolean;
}
export async function executeProcess(options: ProcessOptions): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number }> {
  options.signal?.throwIfAborted();
  const started = Date.now(), maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const child = spawn(options.executable, options.args, { cwd: options.cwd, env: { ...(options.inheritEnv === false ? {} : process.env), ...options.env }, detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", size = 0, stopped: AppError | undefined, settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
    };
    const stop = (error: AppError) => {
      if (stopped || settled) return;
      stopped = error; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 300); killTimer.unref();
    };
    const onAbort = () => stop(new AppError("CANCELLED", "执行已取消"));
    const timer = setTimeout(() => stop(new AppError("TIMEOUT", "执行超过超时时间")), options.timeoutMs ?? 300000);
    const append = (stream: "stdout" | "stderr", data: Buffer) => {
      size += data.byteLength;
      if (size > maxBytes) { stop(new AppError("OUTPUT_LIMIT", "进程输出超过上限")); return; }
      const text = decoders[stream].write(data);
      if (stream === "stdout") stdout += text; else stderr += text;
      try { options.onLog?.(stream, text); } catch (error) { stop(new AppError("INVALID_PROCESS_STREAM", error instanceof Error ? error.message : String(error))); }
    };
    child.stdout.on("data", (data: Buffer) => append("stdout", data));
    child.stderr.on("data", (data: Buffer) => append("stderr", data));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const cleanup = () => {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (stopped) kill("SIGKILL");
      options.signal?.removeEventListener("abort", onAbort); settled = true;
    };
    child.on("error", error => { cleanup(); reject(new AppError("PROCESS_START_FAILED", error.message)); });
    child.on("close", exitCode => {
      if (settled) return;
      stdout += decoders.stdout.end(); stderr += decoders.stderr.end(); cleanup();
      if (stopped) reject(stopped);
      else resolve({ stdout, stderr, exitCode, durationMs: Date.now() - started });
    });
  });
}
