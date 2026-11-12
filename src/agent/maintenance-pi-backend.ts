import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
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

export function readMaintenancePiConfig(path: string): MaintenancePiConfig {
  const stat = lstatSync(path);
  check(isAbsolute(path) && realpathSync(path) === path && stat.isFile() && stat.nlink === 1 &&
    stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 8192,
  "MAINTENANCE_PACKAGE_INVALID", "维护后端配置必须为本机私有文件", 503);
  const entry = { type: "object", required: ["path", "sha256"], additionalProperties: false,
    properties: { path: { type: "string", minLength: 1 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } };
  const directory = { type: "string", minLength: 1 };
  const properties = { pi: entry, extension: entry, helper: entry, privateHome: directory, agentDir: directory,
    model: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,199}$" } };
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  assertSchema(config, { type: "object", properties, required: Object.keys(properties), additionalProperties: false }, "维护 Pi 配置");
  return config as MaintenancePiConfig;
}

export const maintenancePiFingerprint = (config: MaintenancePiConfig) => digest(canonicalJson(config));

export async function runMaintenancePiTurn(pi: MaintenanceManagedProcess, model: string, prompt: string, abort: AbortSignal): Promise<string> {
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
