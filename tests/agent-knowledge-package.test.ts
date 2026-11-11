import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";
import { temporaryKnowledgeRoot } from "./knowledge-fixtures.js";

test("npm tarball contains Markdown and hidden .agents; compiled bundle loads without source from another cwd", { timeout: 60_000 }, t => {
  const root = temporaryKnowledgeRoot(t), packageRoot = join(root, "package-fixture"), dist = join(packageRoot, "dist"), archive = join(root, "archive"), extracted = join(root, "unpacked"), cwd = join(root, "elsewhere");
  for (const directory of [packageRoot, archive, extracted, cwd]) mkdirSync(directory);
  const project = fileURLToPath(new URL("../", import.meta.url));
  const packageJson = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "orchard-knowledge-package-fixture", version: "1.0.0", type: packageJson.type, files: packageJson.files }));
  execFileSync(process.execPath, [join(project, "node_modules/typescript/bin/tsc"), "-p", join(project, "tsconfig.server.json"), "--outDir", dist], { cwd: project, timeout: 30_000, stdio: "pipe" });
  const bundle = loadKnowledgeBundle();
  for (const [relative, text] of Object.entries({ ...bundle.files, "manifest.json": bundle.manifestText })) {
    const target = join(dist, "agent/knowledge", relative); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text, { flag: "wx" });
  }
  const userConfig = join(root, "empty.npmrc"); writeFileSync(userConfig, "");
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", archive], {
    cwd: packageRoot, timeout: 30_000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: userConfig, npm_config_cache: join(root, "npm-cache"), npm_config_loglevel: "error", npm_config_update_notifier: "false" },
  });
  const result = JSON.parse(output)[0] as { filename: string; files: { path: string }[] };
  const shipped = new Set(result.files.map(file => file.path));
  for (const path of ["manifest.json", ...Object.keys(bundle.files)]) assert.ok(shipped.has(`dist/agent/knowledge/${path}`), `missing packed resource: ${path}`);
  assert.ok(![...shipped].some(path => path.startsWith("src/") || path.startsWith("scripts/")));
  execFileSync("tar", ["-xzf", join(archive, result.filename), "-C", extracted], { timeout: 10_000, stdio: "pipe" });
  const installed = join(extracted, "package");
  assert.equal(existsSync(join(installed, "src")), false);
  const module = pathToFileURL(join(installed, "dist/agent/knowledge-bundle.js")).href;
  const script = `const {loadKnowledgeBundle}=await import(${JSON.stringify(module)});const bundle=loadKnowledgeBundle();console.log(JSON.stringify({hash:bundle.hash,files:Object.keys(bundle.files).sort()}));`;
  const loaded = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd, timeout: 10_000, encoding: "utf8" }));
  assert.equal(loaded.hash, bundle.hash);
  assert.deepEqual(loaded.files, Object.keys(bundle.files).sort());
});
