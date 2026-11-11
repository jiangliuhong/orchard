#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { installNativeHost, uninstallNativeHost } from "../web-bridge/install.js";
import { catalogHash, extensionDirectory, extensionId } from "../web-bridge/catalog.js";
import { runNativeHost } from "../web-bridge/native-host.js";
import { existsSync, readFileSync } from "node:fs";
import { configGitHelp, runConfigGitCli } from "../config-git/cli.js";
import { secretsHelp, runSecretsCli } from "../secrets/cli.js";
import { previewAgentReset } from "../agent/reset-preview.js";
import { check } from "../domain/errors.js";

const args = process.argv.slice(2);
const port = Number(value("--port", "7441")), serverUrl = value("--server-url", `http://127.0.0.1:${port}`);
const dataDir = resolve(value("--data-dir", join(homedir(), ".orchard")));
function value(name: string, fallback: string) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1] ?? fallback; }
function help() { console.log(`orchard server [--port <port>] [--data-dir <dir>]
orchard agent-reset preview --data-dir <dir> [--pretty]
orchard web-bridge install|uninstall|chrome-ext|status|applications|tools [application]|tool <application> <tool>|doctor
${configGitHelp}
${secretsHelp}`); }
async function request(path: string, init?: RequestInit) {
  try {
    const headers = new Headers(init?.headers);
    const tokenPath = join(dataDir, "runtime", "api-token");
    if (existsSync(tokenPath)) headers.set("x-orchard-token", readFileSync(tokenPath, "utf8").trim());
    const response = await fetch(`${serverUrl}${path}`, { ...init, headers });
    const body = await response.json() as any;
    if (!response.ok) { console.error(JSON.stringify(body)); process.exitCode = 1; return; }
    console.log(args.includes("--pretty") ? JSON.stringify(body, null, 2) : JSON.stringify(body));
  } catch { console.error(JSON.stringify({ code: "SERVER_NOT_RUNNING", message: "Orchard 服务未启动" })); process.exitCode = 1; }
}
async function main() {
  if (!args.length || args.includes("--help")) return help();
  if (args[0] === "server") {
    const child = execFileSync(process.execPath, [new URL("../server/main.js", import.meta.url).pathname, ...args.slice(1)], { stdio: "inherit" }); return child;
  }
  if (args[0] === "agent-reset" && args[1] === "preview") {
    check(value("--data-dir", "") && !value("--data-dir", "").startsWith("--"),
      "DATA_DIR_REQUIRED", "请显式指定需要预览的 Orchard 数据目录");
    console.log(JSON.stringify(previewAgentReset(dataDir), null, args.includes("--pretty") ? 2 : undefined));
    return;
  }
  if (args[0] === "config-git") return runConfigGitCli(args.slice(1), { dataDir, request, output: body => console.log(JSON.stringify(body, null, args.includes("--pretty") ? 2 : undefined)) });
  if (args[0] === "secrets") return runSecretsCli(args.slice(1), { dataDir, request: async (path, init) => {
    // 复用本地 API 请求路径；非 2xx 时抛出带 code 的错误以走统一 CLI 错误出口。
    const headers = new Headers(init?.headers);
    const tokenPath = join(dataDir, "runtime", "api-token");
    if (existsSync(tokenPath)) headers.set("x-orchard-token", readFileSync(tokenPath, "utf8").trim());
    const response = await fetch(`${serverUrl}${path}`, { ...init, headers });
    const body = await response.json() as any;
    if (!response.ok) throw Object.assign(new Error(body.message ?? "请求失败"), { code: body.code ?? "REQUEST_FAILED" });
    return body;
  }, output: body => console.log(JSON.stringify(body, null, args.includes("--pretty") ? 2 : undefined)) });
  if (args[0] !== "web-bridge") return help();
  const command = args[1];
  if (command === "install") return console.log(JSON.stringify(installNativeHost(dataDir, process.argv[1], { serverUrl, extensionId: value("--extension-id", extensionId) })));
  if (command === "uninstall") return console.log(JSON.stringify({ manifest: uninstallNativeHost(dataDir) }));
  if (command === "chrome-ext") {
    console.log(`Extension directory: ${extensionDirectory()}\nVersion: 0.1.0\nCatalog hash: ${catalogHash}\nLoad it from chrome://extensions with Developer mode enabled.`);
    if (args.includes("--open") && process.platform === "darwin") execFileSync("open", ["chrome://extensions"], { stdio: "ignore" });
    return;
  }
  if (command === "status") return request("/api/web-bridge/status");
  if (command === "applications") return request("/api/web-bridge/applications");
  if (command === "tools") return request(`/api/web-bridge/tools${args[2] ? `?application=${encodeURIComponent(args[2])}` : ""}`);
  if (command === "tool") {
    const application = args[2], tool = args[3]; let body = "{}";
    const jsonArg = value("--args-json", ""); const file = value("--args-file", "");
    if (jsonArg) body = jsonArg; else if (file) body = await (await import("node:fs/promises")).readFile(file, "utf8"); else if (args.includes("--stdin-json")) body = await new Promise<string>(resolve => { let text = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => text += chunk); process.stdin.on("end", () => resolve(text)); });
    return request("/api/web-bridge/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), application, tool, args: JSON.parse(body), environmentId: value("--environment-id", "") || undefined, approved: args.includes("--approve") }) });
  }
  if (command === "doctor") return request("/api/web-bridge/doctor");
  if (command === "host") {
    const origin = args.find(arg => /^chrome-extension:\/\//.test(arg));
    await runNativeHost(serverUrl, value("--extension-id", extensionId), origin, process.stdin, data => { process.stdout.write(data); });
    return;
  }
  return help();
}
void main().catch(error => {
  console.error(JSON.stringify({ code: error?.code ?? "CLI_ERROR", message: error instanceof Error ? error.message : "Command failed" }));
  process.exitCode = 1;
});
