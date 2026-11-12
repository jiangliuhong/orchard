import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "./app.js";
import { Store } from "../persistence/store.js";
import { Bootstrap } from "./bootstrap.js";
import { createProductionMaintenance } from "../agent/maintenance-production.js";

function option(name: string, fallback: string) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] ?? fallback; }
if (!["darwin", "linux"].includes(process.platform)) throw new Error("第一版仅支持 macOS 和 Linux 本地进程管理");
const port = Number(option("--port", "7441"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须为 1–65535");
const defaultDataDir = process.env.ORCHARD_DEV === "1" ? join(process.cwd(), ".orchard") : join(homedir(), ".orchard");
const root = resolve(option("--data-dir", defaultDataDir));
const bootstrap = new Bootstrap(root, port);
const services = createApp(undefined, undefined, undefined, bootstrap, {}, createProductionMaintenance);
const { app } = services;
try {
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Orchard Workbench: http://127.0.0.1:${port}\nData: ${root}\n正在检查数据…`);
  void bootstrap.start(() => services.initialize(new Store(bootstrap.root, bootstrap.lease)), services.activate).then(() => console.log(`Data status: ${bootstrap.status().state}`));
} catch (error) { await app.close(); throw error; }
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (!closing) { closing = true; void app.close().then(() => process.exit(0)); }
});
