import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { watch as watchFiles } from "node:fs";
import { build, context } from "esbuild";

const run = (command, args, options = {}) => spawn(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
const children = [];
let shuttingDown = false;

async function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

try {
  // Compile once before starting the server so `node --watch` has an entrypoint.
  const initial = run("pnpm", ["build"]);
  children.push(initial);
  const initialCode = await new Promise((resolve) => initial.once("exit", resolve));
  children.splice(children.indexOf(initial), 1);
  if (initialCode !== 0) throw new Error("Initial build failed");

  const ts = run("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--watch", "--preserveWatchOutput"]);
  children.push(ts);

  const web = await context({
    entryPoints: ["src/web/App.tsx"], bundle: true, minify: true, format: "iife",
    platform: "browser", target: "es2020", outfile: "dist/server/client.js",
    plugins: [{ name: "copy-workbench-css", setup(build) { build.onEnd(async () => { await mkdir("dist/server", { recursive: true }); await copyFile("src/web/workbench.css", "dist/server/workbench.css"); }); } }],
  });
  await web.watch();

  let server = run(process.execPath, ["dist/cli/main.js"]);
  children.push(server);
  let restarting = false;
  let restartTimer;
  const restartServer = () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (shuttingDown || restarting) return;
      restarting = true;
      server.once("exit", () => { if (!shuttingDown) { server = run(process.execPath, ["dist/cli/main.js"]); restarting = false; } });
      server.kill("SIGTERM");
    }, 150);
  };
  const distWatcher = watchFiles("dist", { recursive: true }, (_event, filename) => { if (filename?.endsWith(".js")) restartServer(); });
  children.push({ kill: () => distWatcher.close() });
  process.stdout.write("Orchard dev mode: TypeScript, web bundle, and server reload are enabled.\n");

  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
} catch (error) {
  console.error(error);
  await stop(1);
}
