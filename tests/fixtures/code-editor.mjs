import { createElement } from "react";

export default function CodeEditor({ value, path, onChange }) {
  return createElement("textarea", {
    "aria-label": `代码：${path}`,
    value,
    readOnly: !onChange,
    onChange: event => onChange?.(event.target.value),
  });
}

export function CodeDiffEditor({ modified, path }) {
  return createElement("pre", { "aria-label": `变更差异：${path}` }, modified);
}
