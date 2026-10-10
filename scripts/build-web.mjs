import { copyFileSync } from "node:fs";
import { build } from "esbuild";
import { webBuildOptions, editorWorkerBuildOptions } from "./web-build-options.mjs";
await Promise.all([build(webBuildOptions), build(editorWorkerBuildOptions)]);
copyFileSync("src/web/workbench.css", "dist/server/workbench.css");
