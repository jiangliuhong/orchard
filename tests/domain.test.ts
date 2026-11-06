import { test } from "node:test";
import assert from "node:assert/strict";
import { exampleFiles, temporary } from "./helpers.js";
import { validateWorkflow, resolveBinding, pointer } from "../src/domain/validation.js";
import { FileStore, compileScripts, readDefinition, checkFiles } from "../src/persistence/files.js";
import { symlinkSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("graph rejects invalid formats, IDs, cycles, dangling nodes, fanout and Switch routes", () => {
  const valid = JSON.parse(exampleFiles()["workflow.json"]!);
  assert.equal(validateWorkflow(valid).nodes.length, 4);
  for (const change of [
    (g: typeof valid) => { g.formatVersion = 2; },
    (g: typeof valid) => { g.nodes[1].id = "a"; },
    (g: typeof valid) => { g.edges[0].to = "missing"; },
    (g: typeof valid) => { g.edges.push({ id: "cycle", from: "c", to: "a" }); },
    (g: typeof valid) => { g.edges.push({ id: "fanout", from: "a", to: "c" }); },
    (g: typeof valid) => { g.nodes[2].config.cases[1].value = "execute"; },
    (g: typeof valid) => { g.edges = g.edges.filter((e: { id: string }) => e.id !== "skip"); },
    (g: typeof valid) => { g.nodes[0].config.extra = true; },
  ]) { const candidate = structuredClone(valid); change(candidate); assert.throws(() => validateWorkflow(candidate)); }
});
test("script nodes require fixed library identities", () => {
  const valid = JSON.parse(exampleFiles()["workflow.json"]!);
  valid.nodes[0] = { id: "a", name: "Library script", type: "script", input: { source: "workflow" }, outputSchema: true, config: { scriptId: "normalize-text", scriptVersionId: "version-1" } };
  assert.doesNotThrow(() => validateWorkflow(valid));
  const invalid = structuredClone(valid); delete invalid.nodes[0].config.scriptVersionId;
  assert.throws(() => validateWorkflow(invalid));
});

test("bindings require dominance on every path, including final output", () => {
  const valid = JSON.parse(exampleFiles()["workflow.json"]!);
  valid.nodes.push({ id: "end", name: "End", type: "code.nodejs", input: { source: "node", nodeId: "c" }, config: { script: "scripts/a.ts" }, outputSchema: true });
  valid.edges.push({ id: "c-end", from: "c", to: "end" });
  valid.edges.find((e: { id: string }) => e.id === "skip").to = "end";
  assert.throws(() => validateWorkflow(valid), /并非所有路径/);
  valid.nodes[4].input = { source: "node", nodeId: "b" };
  assert.doesNotThrow(() => validateWorkflow(valid));
  valid.result = { source: "node", nodeId: "c" };
  assert.throws(() => validateWorkflow(valid), /并非所有路径/);
});
test("binding resolution uses JSON Pointer and preserves data without expression evaluation", () => {
  const input = { "a/b": { "~": "literal $(echo x)" } };
  assert.equal(pointer(input, "/a~1b/~0"), "literal $(echo x)");
  assert.throws(() => pointer({}, "/missing"));
  assert.throws(() => pointer({}, "/bad~2"));
  assert.deepEqual(resolveBinding({ source: "object", properties: { result: { source: "node", nodeId: "a", pointer: "/x" } } }, null, new Map([["a", { x: 3 }]])), { result: 3 });
});
test("source validation never executes user modules and rejects external imports", async () => {
  const files = exampleFiles(), graph = readDefinition(files);
  files["scripts/a.ts"] = "throw new Error('must not run');export default()=>3";
  assert.ok((await compileScripts(files, graph)).a);
  files["scripts/a.ts"] = "import x from 'unapproved-package';export default()=>x";
  await assert.rejects(compileScripts(files, graph), /只允许/);
  const invalidShell = exampleFiles(); invalidShell["scripts/c.sh"] = "if then";
  await assert.rejects(compileScripts(invalidShell, readDefinition(invalidShell)), /Shell 语法错误/);
  assert.throws(() => checkFiles({ ...files, "../escape.ts": "x" }), /文件/);
});
test("immutable source and blobs detect tampering and reject symlink ancestors", t => {
  const root = temporary(t), store = new FileStore(root), tree = store.saveTree(exampleFiles());
  assert.equal(store.readTree(tree.path).files["scripts/c.sh"], exampleFiles()["scripts/c.sh"]);
  writeFileSync(store.path(tree.path), "{}");
  assert.throws(() => store.readTree(tree.path), { code: "ARTIFACT_MISMATCH" });
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "linked"));
  assert.throws(() => store.path("linked/x"), /符号链接/);
});
test("documented decision example validates and compiles without executing scripts", async () => {
  const root = new URL("../examples/decision/", import.meta.url);
  const files = Object.fromEntries(["workflow.json", "scripts/a.ts", "scripts/c.sh"].map(name => [name, readFileSync(new URL(name, root), "utf8")]));
  const graph = readDefinition(files);
  assert.equal(graph.id, "decision-example");
  assert.ok((await compileScripts(files, graph)).a);
});
