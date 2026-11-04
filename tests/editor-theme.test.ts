import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { editorColor, editorTheme } from "../src/web/lib/editor-theme.js";

// Exercise Monaco's actual color parser that produced the reported exception.
const { ColorMap } = await import(new URL("../node_modules/monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js", import.meta.url).href);

test("editor theme accepts minified shorthand through Monaco's real token color parser", () => {
  const palette = new ColorMap();
  assert.throws(() => palette.getId("#fff"), /Illegal value for token color/);
  for (const input of ["#fff", "#abcd", "#FFFFFF", "#ecebfb", "#00000012"]) {
    assert.doesNotThrow(() => palette.getId(editorColor(input)));
  }
  assert.equal(editorColor(" #fff "), "#ffffff");
  assert.equal(editorColor("#abcd"), "#aabbccdd");
});

test("light and dark editor themes use valid colors and fall back to the base for missing or invalid variables", () => {
  const css = readFileSync(new URL("../src/web/styles.css", import.meta.url), "utf8");
  for (const mode of ["light", "dark"] as const) {
    const block = css.match(mode === "dark" ? /:root\.dark\s*\{([^}]+)\}/ : /:root\s*\{([^}]+)\}/)![1]!;
    const variables = new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!]));
    const theme = editorTheme(mode, name => variables.get(name) ?? "");
    assert.equal(theme.base, mode === "dark" ? "vs-dark" : "vs");
    assert.equal(Object.keys(theme.colors).length, 7);
    const palette = new ColorMap();
    for (const color of Object.values(theme.colors)) assert.doesNotThrow(() => palette.getId(color));
  }
  const fallback = editorTheme("light", name => name === "--foreground" ? "#111" : "invalid");
  assert.deepEqual(fallback.colors, { "editor.foreground": "#111111" });
  assert.equal(fallback.inherit, true);
});
