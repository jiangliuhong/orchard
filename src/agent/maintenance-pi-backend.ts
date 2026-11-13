import { check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { MaintenanceManagedProcess } from "./maintenance-processes.js";

export interface MaintenancePiConfig {
  model: string;
  pi: { path: string; sha256: string };
  extension: { path: string; sha256: string };
  helper: { path: string; sha256: string };
  privateHome: string;
  agentDir: string;
}

export const maintenancePiFingerprint = (config: MaintenancePiConfig) => digest(canonicalJson(config));

export async function runMaintenancePiTurn(pi: MaintenanceManagedProcess, model: string, prompt: string, abort: AbortSignal, session?: { id: string; resumeFile?: string; record(file: string): void }): Promise<string> {
  const signal = AbortSignal.any([abort, AbortSignal.timeout(120_000)]);
  signal.throwIfAborted();
  const output = pi.stdout.iterator({ destroyOnReturn: false });
  const fail = () => pi.stdout.destroy();
  signal.addEventListener("abort", fail, { once: true });
  pi.stderr.resume();
  let buffer = Buffer.alloc(0), accepted = false, prompted = false, finalText = "";
  const send = (value: object) => pi.stdin.write(JSON.stringify(value) + "\n");
  try {
    send({ id: "state", type: "get_state" });
    for await (const chunk of output) {
      signal.throwIfAborted();
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      check(buffer.length <= 8 * 1024 * 1024, "INVALID_AGENT_OUTPUT", "Pi 维护协议超出大小限制");
      let newline: number;
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (!line.length) continue;
        const event = JSON.parse(line.toString("utf8"));
        if (event.type === "response" && event.id === "state" && !prompted) {
          const actual = event.data?.model;
          check(event.success && !event.data?.isStreaming &&
            (actual?.id === model || `${actual?.provider}/${actual?.id}` === model),
          "BACKEND_UNAVAILABLE", "Pi 未启用已配置的维护模型", 503);
          if (session) check(event.data.sessionId === session.id && (!session.resumeFile || event.data.sessionFile === session.resumeFile),
            "BACKEND_REFERENCE_INVALID", "Pi 未打开指定的维护会话", 409);
          prompted = true;
          send({ id: "maintenance", type: "prompt", message: prompt });
        } else if (event.type === "response" && event.id === "maintenance") {
          check(event.success && event.data?.disposition === "started", "PROVIDER_FAILED", "Pi 未接受维护任务");
          accepted = true;
        } else if (prompted && event.type === "message_end" && event.message?.role === "assistant") {
          const message = event.message;
          check(message.stopReason !== "error", "PROVIDER_FAILED", "Pi 维护模型执行失败");
          finalText = Array.isArray(message.content) ? message.content.filter((part: { type: string }) => part.type === "text")
            .map((part: { text: string }) => part.text).join("") : "";
        } else if (event.type === "agent_settled" && accepted) {
          check(!event.aborted && finalText.length > 0, "INVALID_AGENT_OUTPUT", "Pi 未返回维护结果");
          if (!session) return finalText;
          send({ id: "session", type: "get_state" });
        } else if (session && event.type === "response" && event.id === "session") {
          check(event.success && !event.data?.isStreaming && event.data?.sessionId === session.id &&
            typeof event.data.sessionFile === "string" && (!session.resumeFile || event.data.sessionFile === session.resumeFile),
          "BACKEND_REFERENCE_INVALID", "Pi 未保存指定的维护会话", 409);
          session.record(event.data.sessionFile);
          return finalText;
        }
      }
    }
    signal.throwIfAborted();
    check(false, "PROVIDER_FAILED", "Pi 在维护任务完成前退出");
  } finally {
    signal.removeEventListener("abort", fail);
  }
}
