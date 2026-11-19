import { spawn } from "node:child_process";
import { build } from "esbuild";

const bundleMaintenance = () => build({
  entryPoints: ["src/agent/maintenance-pi-extension.ts", "src/agent/maintenance-mcp-stdio.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist/agent/maintenance-bundles",
  outExtension: { ".js": ".mjs" },
});

await bundleMaintenance();

const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" });
let backend;
let stopping = false;
let preparingRestart = false;
let replacingBackend;

const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  backend?.kill("SIGTERM");
  vite.kill("SIGTERM");
};

function startBackend() {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts", "--port", "7443"], {
    stdio: "inherit",
    env: { ...process.env, ORCHARD_DEV: "1" },
  });
  backend = child;
  child.once("error", error => {
    console.error("无法启动 Orchard 后端", error);
    stop(1);
  });
  child.once("exit", code => {
    backend = undefined;
    if (stopping) return;
    if (replacingBackend !== child) {
      stop(code ?? 1);
      return;
    }
    replacingBackend = undefined;
    startBackend();
  });
}

vite.once("error", error => {
  console.error("无法启动 Vite", error);
  stop(1);
});
vite.once("exit", code => stop(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
process.on("SIGUSR2", async () => {
  if (stopping || preparingRestart || replacingBackend || !backend) return;
  preparingRestart = true;
  try {
    await bundleMaintenance();
    if (stopping || !backend) return;
    console.log("正在重启 Orchard 后端，Vite 继续运行。");
    replacingBackend = backend;
    backend.kill("SIGTERM");
  } catch (error) {
    console.error("无法构建后端启动所需的维护组件", error);
  } finally {
    preparingRestart = false;
  }
});

startBackend();
console.log(`仅重启 Orchard 后端（保留 Vite）：kill -USR2 ${process.pid}`);
