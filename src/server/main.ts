import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "./app.js";
import { Store } from "../persistence/store.js";

function option(name: string, fallback: string) { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1] ?? fallback; }
if (!["darwin", "linux"].includes(process.platform)) throw new Error("第一版仅支持 macOS 和 Linux 本地进程管理");
const port = Number(option("--port", "7441"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口必须为 1–65535");
const root = resolve(option("--data-dir", join(homedir(), ".orchard-workbench")));
const { app } = createApp(new Store(root));
try {
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Orchard Workbench: http://127.0.0.1:${port}\nData: ${root}`);
} catch (error) { await app.close(); throw error; }
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (!closing) { closing = true; void app.close().then(() => process.exit(0)); }
});
