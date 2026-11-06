import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { catalogHash, extensionDirectory, extensionId } from "./catalog.js";

export function installNativeHost(dataDir: string, executable = process.argv[1] ?? process.execPath) {
  const directory = join(dataDir, "runtime", "native-host");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest = join(directory, "com.jiangliuhong.orchard.json");
  const temp = `${manifest}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify({ name: "com.jiangliuhong.orchard", description: "Orchard Web Bridge", path: executable, args: ["web-bridge", "host", "--data-dir", dataDir], type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`], orchard: { dataDir, catalogHash } }, null, 2), { mode: 0o600 });
  renameSync(temp, manifest); chmodSync(manifest, 0o600);
  return { manifest, extension: extensionDirectory(), catalogHash };
}
export function uninstallNativeHost(dataDir: string) {
  const manifest = join(dataDir, "runtime", "native-host", "com.jiangliuhong.orchard.json");
  if (existsSync(manifest)) {
    const value = JSON.parse(readFileSync(manifest, "utf8")) as { orchard?: unknown };
    if (value.orchard) rmSync(manifest);
  }
  return manifest;
}
export function ensureRuntime(dataDir: string) { mkdirSync(dirname(join(dataDir, "runtime", "web-bridge.sock")), { recursive: true, mode: 0o700 }); }
