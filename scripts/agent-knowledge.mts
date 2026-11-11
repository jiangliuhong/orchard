import { mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKnowledgeManifest, loadKnowledgeBundle } from "../src/agent/knowledge-bundle.js";

const source = resolve(fileURLToPath(new URL("../src/agent/knowledge/", import.meta.url)));
const target = resolve(fileURLToPath(new URL("../dist/agent/knowledge/", import.meta.url)));
const args = process.argv.slice(2), mode = args[0];
if (mode === "--update" && args.length === 3 && args[1] === "--bundle-version") {
  const manifest = createKnowledgeManifest(source, args[2]!);
  writeFileSync(join(source, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Updated built-in knowledge manifest: ${manifest.bundleVersion}`);
} else if ((mode === "--check" || mode === "--copy") && args.length === 1) {
  const bundle = loadKnowledgeBundle(source);
  if (mode === "--copy") {
    if (existsSync(target)) throw new Error("Knowledge build target already exists; run the normal clean build");
    // Only the package dist target, never the runtime data directory. Write validated immutable text,
    // not a second read/copy of source files which may have changed after validation.
    if (realpathSync(dirname(target)) !== dirname(target)) throw new Error("Knowledge build parent contains a symlink");
    mkdirSync(target);
    for (const [relative, text] of Object.entries({ ...bundle.files, "manifest.json": bundle.manifestText })) {
      const file = join(target, relative); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text, { flag: "wx", mode: 0o644 });
    }
    if (loadKnowledgeBundle(target).hash !== bundle.hash) throw new Error("Copied knowledge hash mismatch");
  }
  console.log(`Verified built-in knowledge: ${bundle.hash}`);
} else {
  console.error("Usage: node --import tsx scripts/agent-knowledge.mts --check|--copy|--update --bundle-version <version>");
  process.exitCode = 1;
}
