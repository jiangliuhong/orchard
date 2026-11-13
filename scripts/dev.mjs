import { spawn } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: ["src/agent/maintenance-pi-extension.ts", "src/agent/maintenance-mcp-stdio.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: "dist/agent/maintenance-bundles",
  outExtension: { ".js": ".mjs" },
});

const processes = [
  spawn(process.execPath, ["--import", "tsx", "src/server/main.ts", "--port", "7443"], { stdio: "inherit", env: { ...process.env, ORCHARD_DEV: "1" } }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], { stdio: "inherit" }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 100);
};
for (const child of processes) child.once("exit", code => { if (!stopping) stop(code ?? 1); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop());
