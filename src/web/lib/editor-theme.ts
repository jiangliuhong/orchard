import type { editor } from "monaco-editor/editor/editor.api.js";

// CSS minification can shorten #ffffff to #fff. Monaco's token palette only
// accepts six/eight digit hex, including colors inherited from editor.background.
export function editorColor(value: string): string | undefined {
  const color = value.trim();
  if (/^#[\da-f]{3,4}$/i.test(color)) {
    return `#${[...color.slice(1)].map(digit => digit + digit).join("")}`;
  }
  return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color) ? color : undefined;
}

export function editorTheme(theme: "light" | "dark", readColor: (name: string) => string): editor.IStandaloneThemeData {
  const variables: Record<string, string> = {
    "editor.background": "--card",
    "editor.foreground": "--foreground",
    "editorGutter.background": "--card",
    "editorLineNumber.foreground": "--faint",
    "editor.selectionBackground": "--selection",
    "editor.lineHighlightBackground": "--surface-2",
    "editorCursor.foreground": "--primary",
  };
  return {
    base: theme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: Object.fromEntries(Object.entries(variables).flatMap(([key, variable]) => {
      const color = editorColor(readColor(variable));
      return color ? [[key, color]] : [];
    })),
  };
}
