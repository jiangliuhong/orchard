import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import { useTheme } from "../lib/theme";
import { editorTheme } from "../lib/editor-theme";
(globalThis as typeof globalThis & { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = { getWorker: () => new EditorWorker() };
export default function CodeEditor({ value, path, onChange }: { value: string; path: string; onChange?: (value: string) => void }) {
  const container = useRef<HTMLDivElement>(null), editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null), callback = useRef(onChange);
  const applyingExternalValue = useRef(false);
  const { resolvedTheme } = useTheme();
  callback.current = onChange;
  useEffect(() => {
    if (!container.current) return;
    const instance = monaco.editor.create(container.current, { value, language: path.endsWith(".sh") ? "shell" : path.endsWith(".json") ? "json" : "typescript", readOnly: !onChange, automaticLayout: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, padding: { top: 16 }, wordWrap: "on" });
    editor.current = instance;
    const listener = instance.onDidChangeModelContent(() => { if (!applyingExternalValue.current) callback.current?.(instance.getValue()); });
    return () => { listener.dispose(); instance.getModel()?.dispose(); instance.dispose(); editor.current = null; };
  }, [path, !!onChange]);
  useEffect(() => {
    if (editor.current && editor.current.getValue() !== value) {
      applyingExternalValue.current = true;
      try { editor.current.setValue(value); } finally { applyingExternalValue.current = false; }
    }
  }, [value]);
  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    monaco.editor.defineTheme("orchard", editorTheme(resolvedTheme, name => styles.getPropertyValue(name)));
    monaco.editor.setTheme("orchard");
  }, [resolvedTheme]);
  return <div className="code-editor" ref={container} aria-label={`代码：${path}`} />;
}
