import { copyFileSync } from "node:fs";
import { build } from "esbuild";
await build({ entryPoints: ["src/web/App.tsx"], bundle: true, minify: true, format: "iife", platform: "browser", target: "es2020", outfile: "dist/server/client.js" });
copyFileSync("src/web/workbench.css", "dist/server/workbench.css");
