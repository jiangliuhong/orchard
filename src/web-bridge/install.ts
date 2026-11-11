import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { catalogHash, extensionDirectory, extensionId } from "./catalog.js";
import { check } from "../domain/errors.js";

const hostName = "com.jiangliuhong.orchard";
interface HostOptions { home?: string; platform?: string; extensionId?: string; serverUrl?: string }
export function localServerUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("服务地址必须为本机 HTTP origin"); }
  check(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "INVALID_SERVER_URL", "服务地址必须为本机 HTTP origin");
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}
export function nativeHostManifest(options: HostOptions = {}) {
  const platform = options.platform ?? process.platform, home = options.home ?? homedir();
  check(["darwin", "linux"].includes(platform), "UNSUPPORTED_PLATFORM", "仅支持 macOS 和 Linux");
  return join(home, platform === "darwin" ? "Library/Application Support/Google/Chrome/NativeMessagingHosts" : ".config/google-chrome/NativeMessagingHosts", `${hostName}.json`);
}
function atomicFile(path: string, text: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const fd = openSync(temp, "wx", mode);
    try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    chmodSync(temp, mode); renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
  finally { rmSync(temp, { force: true }); }
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function installNativeHost(dataDir: string, executable = process.argv[1] ?? process.execPath, options: HostOptions = {}) {
  const root = resolve(dataDir), id = options.extensionId ?? extensionId;
  check(/^[a-p]{32}$/.test(id), "INVALID_EXTENSION_ID", "Chrome 扩展 ID 无效");
  check(isAbsolute(executable) && existsSync(executable), "INVALID_EXECUTABLE", "Orchard 入口必须是已存在的绝对路径");
  const serverUrl = localServerUrl(options.serverUrl ?? "http://127.0.0.1:7441");
  const directory = join(root, "runtime", "native-host"), launcher = join(directory, "orchard-host");
  const manifest = nativeHostManifest(options);
  // Chrome does not support an args field. Its path must be an executable launcher.
  const value = { name: hostName, description: "Orchard Web Bridge", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${id}/`] };
  if (existsSync(manifest)) {
    const current = JSON.parse(readFileSync(manifest, "utf8")) as { path?: string };
    check(current.path === launcher, "NATIVE_HOST_CONFLICT", "Native Host 已绑定其他数据目录，请先卸载原绑定");
  }
  atomicFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(executable)} web-bridge host --data-dir ${quote(root)} --server-url ${quote(serverUrl)} --extension-id ${quote(id)} "$@"\n`, 0o700);
  atomicFile(manifest, JSON.stringify(value, null, 2), 0o600);
  return { manifest, launcher, extension: extensionDirectory(), extensionId: id, serverUrl, catalogHash };
}
export function uninstallNativeHost(dataDir: string, options: HostOptions = {}) {
  const manifest = nativeHostManifest(options), launcher = join(resolve(dataDir), "runtime", "native-host", "orchard-host");
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as { path?: string };
    check(value.path === launcher, "NATIVE_HOST_CONFLICT", "Native Host 属于其他数据目录");
    rmSync(manifest); rmSync(launcher, { force: true });
  }
  return manifest;
}
export function nativeHostStatus(options: HostOptions = {}) {
  try {
    const manifest = nativeHostManifest(options);
    if (!existsSync(manifest)) return { ok: false, code: "NATIVE_HOST_NOT_INSTALLED" };
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    const ok = value.name === hostName && value.type === "stdio" && typeof value.path === "string" && isAbsolute(value.path) && existsSync(value.path) && Array.isArray(value.allowed_origins) && value.allowed_origins.length === 1 && /^chrome-extension:\/\/[a-p]{32}\/$/.test(value.allowed_origins[0]);
    return { ok, code: ok ? "NATIVE_HOST_INSTALLED" : "NATIVE_HOST_INVALID" };
  } catch { return { ok: false, code: "NATIVE_HOST_INVALID" }; }
}
export function ensureRuntime(dataDir: string) { mkdirSync(join(dataDir, "runtime"), { recursive: true, mode: 0o700 }); }
