import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createKnowledgeManifest, installedKnowledgeDirectory, loadKnowledgeBundle, REQUIRED_KNOWLEDGE_FILES } from "../src/agent/knowledge-bundle.js";
import { temporaryKnowledgeRoot } from "./knowledge-fixtures.js";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function source(t: import("node:test").TestContext) { const root = temporaryKnowledgeRoot(t), directory = join(root, "knowledge"); cpSync(resolve(installedKnowledgeDirectory()), directory, { recursive: true }); writeFileSync(join(directory, "manifest.json"), loadKnowledgeBundle().manifestText); return { root, directory }; }
function rewrite(directory: string, update: (manifest: ReturnType<typeof createKnowledgeManifest>) => void) {
  const file = join(directory, "manifest.json"), manifest = JSON.parse(readFileSync(file, "utf8")); update(manifest); writeFileSync(file, JSON.stringify(manifest));
}

test("built-in bundle verifies exact UTF-8 byte hashes, profiles and hidden resources", () => {
  const bundle = loadKnowledgeBundle();
  assert.equal(bundle.manifest.formatVersion, 1);
  assert.deepEqual(Object.keys(bundle.manifest.profiles).sort(), ["script", "web-bridge", "workflow"]);
  assert.equal(Object.keys(bundle.files).length, 8);
  for (const file of REQUIRED_KNOWLEDGE_FILES) assert.ok(bundle.files[file]);
  assert.equal(bundle.hash, sha(Buffer.from(bundle.manifestText)));
  for (const file of bundle.manifest.files) { assert.equal(Buffer.byteLength(bundle.files[file.path]!), file.bytes); assert.equal(sha(Buffer.from(bundle.files[file.path]!)), file.sha256); }
  assert.throws(() => { bundle.manifest.files[0]!.bytes = 123; }, TypeError);
  assert.throws(() => { (bundle.files as Record<string, string>)["AGENTS.md"] = "modified"; }, TypeError);
});

test("source manifest generation is deterministic and reading is independent of a caller cwd", t => {
  const { directory } = source(t), first = createKnowledgeManifest(directory, "test.1"), second = createKnowledgeManifest(directory, "test.1");
  assert.deepEqual(first, second);
  assert.equal(loadKnowledgeBundle(directory + "/").hash, loadKnowledgeBundle(directory).hash);
  assert.throws(() => loadKnowledgeBundle("relative/knowledge"), { code: "KNOWLEDGE_BUNDLE_INVALID" });
});

test("manifest formatting and key order do not change the installed knowledge identity", t => {
  const { directory } = source(t);
  const original = loadKnowledgeBundle(directory);
  const reordered = Object.fromEntries(Object.entries(original.manifest).reverse());
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(reordered));
  assert.equal(loadKnowledgeBundle(directory).hash, original.hash);
});

test("manifest rejects traversal, duplicate paths, unsupported versions, profiles and missing files", t => {
  const { directory } = source(t), original = readFileSync(join(directory, "manifest.json"));
  const cases: ((manifest: ReturnType<typeof createKnowledgeManifest>) => void)[] = [
    value => { value.files[0]!.path = "../../outside.md"; },
    value => { value.files[0]!.path = "/outside.md"; },
    value => { value.files[0]!.path = "docs\\outside.md"; },
    value => { value.files.push({ ...value.files[0]! }); },
    value => { (value as unknown as { formatVersion: number }).formatVersion = 2; },
    value => { value.contractVersion = "unknown"; },
    value => { value.files = value.files.filter(file => file.path !== "AGENTS.md"); },
    value => { value.profiles.workflow.skill = value.profiles.script.skill; },
    value => { value.files[0]!.bytes = 1.5; },
    value => { value.files[0]!.sha256 = "bad"; },
  ];
  for (const mutate of cases) {
    writeFileSync(join(directory, "manifest.json"), original); rewrite(directory, mutate);
    assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  }
});

test("duplicate JSON keys, invalid UTF-8, wrong bytes and modified content fail closed", t => {
  const { directory } = source(t), manifest = readFileSync(join(directory, "manifest.json"), "utf8"), file = join(directory, "docs/workflow.md"), original = readFileSync(file);
  writeFileSync(join(directory, "manifest.json"), manifest.replace('"formatVersion": 1', '"formatVersion":1,"formatVersion":1'));
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  writeFileSync(join(directory, "manifest.json"), manifest);
  writeFileSync(file, "tampered"); assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  writeFileSync(file, Buffer.from([0xff]));
  rewrite(directory, value => { const entry = value.files.find(file => file.path === "docs/workflow.md")!; entry.bytes = 1; entry.sha256 = sha(Buffer.from([0xff])); });
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  assert.throws(() => createKnowledgeManifest(directory, "bad"), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  writeFileSync(file, original);
});

test("bundle rejects symlink roots, leaf links, undeclared files and empty directories", t => {
  const { root, directory } = source(t);
  symlinkSync(directory, join(root, "alias"));
  assert.throws(() => loadKnowledgeBundle(join(root, "alias")), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  const file = join(directory, "docs/workflow.md"), original = readFileSync(file); rmSync(file); symlinkSync(join(directory, "docs/script.md"), file);
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  rmSync(file); writeFileSync(file, original);
  writeFileSync(join(directory, "docs/undeclared.md"), "not declared");
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  rmSync(join(directory, "docs/undeclared.md")); mkdirSync(join(directory, "empty"));
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
});

test("hash-correct MCP metadata still cannot add credentials, endpoint or executable configuration", t => {
  const { directory } = source(t), file = join(directory, ".agents/mcp.json");
  const original = readFileSync(file, "utf8"), manifest = readFileSync(join(directory, "manifest.json"));
  for (const extra of [{ token: "do-not-leak" }, { command: "/bin/sh" }, { endpoint: "https://unrelated.example" }]) {
    writeFileSync(file, JSON.stringify({ ...JSON.parse(original), ...extra }));
    writeFileSync(join(directory, "manifest.json"), manifest);
    rewrite(directory, value => { const entry = value.files.find(file => file.path === ".agents/mcp.json")!, bytes = readFileSync(file); entry.bytes = bytes.length; entry.sha256 = sha(bytes); });
    assert.throws(() => loadKnowledgeBundle(directory), error => error instanceof Error && !error.message.includes("do-not-leak"));
    assert.throws(() => createKnowledgeManifest(directory, "unsafe"), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  }
});

test("file count, individual size and declared total bytes have strict budgets", t => {
  const { directory } = source(t), original = readFileSync(join(directory, "manifest.json"));
  rewrite(directory, value => { value.files[0]!.bytes = 1024 * 1024 + 1; });
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  writeFileSync(join(directory, "manifest.json"), original);
  rewrite(directory, value => { for (const file of value.files.slice(0, 5)) file.bytes = 1024 * 1024; });
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
  writeFileSync(join(directory, "manifest.json"), original);
  for (let i = 0; i < 65; i++) writeFileSync(join(directory, `docs/extra-${i}.md`), "bounded");
  assert.throws(() => loadKnowledgeBundle(directory), { code: "KNOWLEDGE_BUNDLE_INVALID" });
});
