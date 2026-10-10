import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "antd";
import type { InputRef } from "antd";
import { FileTextOutlined, SearchOutlined } from "@ant-design/icons";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import { searchSourceFiles } from "./source-search.js";
import type { WorkflowSourceFile } from "../server/workflow-detail.js";

globalThis.MonacoEnvironment = {
  getWorker: () => new Worker("/editor-assets/editor.worker.js", { name: "orchard-monaco" }),
};

const language = (path: string): string => /\.(?:ts|tsx|mts|cts)$/.test(path) ? "typescript" : /\.(?:js|jsx|mjs|cjs)$/.test(path) ? "javascript" : path.endsWith(".md") ? "markdown" : "plaintext";

export function MonacoWorkflowEditor({ files, filePath, focusLine, visible, onSelectFile }: {
  files: readonly WorkflowSourceFile[]; filePath: string; focusLine?: number | undefined;
  visible: boolean; onSelectFile: (path: string) => void;
}) {
  const instanceId = useId();
  const host = useRef<HTMLDivElement>(null);
  const searchInput = useRef<InputRef>(null);
  const fileInput = useRef<InputRef>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>());
  const [mode, setMode] = useState<"files" | "search">("files");
  const [query, setQuery] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const [ready, setReady] = useState(0);
  const [searchTarget, setSearchTarget] = useState<{ file: string; line: number; column: number; length: number }>();
  const matches = useMemo(() => searchSourceFiles(files, query, 1000), [files, query]);
  const sourceLines = useMemo(() => new Map(files.map(file => [file.path, file.code.split("\n")])), [files]);
  const filteredFiles = files.filter(file => file.path.toLowerCase().includes(fileFilter.toLowerCase()));

  useEffect(() => {
    if (!host.current) return;
    const codeEditor = monaco.editor.create(host.current, {
      model: null, theme: "vs-dark", readOnly: true, domReadOnly: true,
      automaticLayout: true, fontSize: 13, lineHeight: 20,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      minimap: { enabled: true, maxColumn: 100 }, scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 }, folding: true, renderLineHighlight: "all",
      ariaLabel: "工作流源码编辑器", find: { addExtraSpaceOnTop: false },
    });
    editor.current = codeEditor;
    for (const file of files) {
      models.current.set(file.path, monaco.editor.createModel(file.code, language(file.path), monaco.Uri.from({ scheme: "orchard-source", path: `/${instanceId}/${file.path}` })));
    }
    const searchAction = codeEditor.addAction({ id: "orchard.searchFiles", label: "搜索全部源码文件", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF], run: () => { setMode("search"); setQuickOpen(false); searchInput.current?.focus({ cursor: "all" }); } });
    const openAction = codeEditor.addAction({ id: "orchard.openFile", label: "切换源码文件", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP], run: () => { setQuickOpen(true); setFileFilter(""); setMode("files"); fileInput.current?.focus({ cursor: "all" }); } });
    setReady(value => value + 1);
    return () => {
      searchAction.dispose(); openAction.dispose(); codeEditor.dispose();
      for (const model of models.current.values()) model.dispose();
      models.current.clear(); viewStates.current.clear(); editor.current = undefined;
    };
  }, [files, instanceId]);

  useEffect(() => {
    const codeEditor = editor.current;
    const model = models.current.get(filePath);
    if (!codeEditor || !model) return;
    const previous = codeEditor.getModel();
    if (previous !== model) {
      const state = codeEditor.saveViewState();
      if (previous && state) viewStates.current.set(previous.uri.toString(), state);
      codeEditor.setModel(model);
      const saved = viewStates.current.get(model.uri.toString());
      if (saved) codeEditor.restoreViewState(saved);
    }
    if (visible) {
      codeEditor.layout();
      if (focusLine !== undefined) {
        const line = Math.min(Math.max(1, focusLine), model.getLineCount());
        codeEditor.setPosition({ lineNumber: line, column: 1 });
        codeEditor.revealLineInCenter(line);
      }
      codeEditor.focus();
    }
  }, [filePath, focusLine, visible, ready]);

  useEffect(() => { if (mode === "search") searchInput.current?.focus(); else if (quickOpen) fileInput.current?.focus(); }, [mode, quickOpen]);

  useEffect(() => {
    if (focusLine !== undefined || !searchTarget || searchTarget.file !== filePath || !visible || !editor.current) return;
    const range = new monaco.Range(searchTarget.line, searchTarget.column + 1, searchTarget.line, searchTarget.column + searchTarget.length + 1);
    editor.current.setSelection(range);
    editor.current.revealRangeInCenter(range);
    editor.current.focus();
  }, [searchTarget, filePath, focusLine, visible, ready]);

  const switchFile = (path: string) => { setSearchTarget(undefined); onSelectFile(path); setQuickOpen(false); editor.current?.focus(); };
  const findInFile = () => { editor.current?.focus(); void editor.current?.getAction("actions.find")?.run(); };
  const selectMatch = (match: typeof matches[number]) => {
    onSelectFile(match.file);
    setSearchTarget({ ...match });
  };
  return <div className="workflow-monaco" aria-label="工作流代码工作区">
    <nav className="monaco-activity" aria-label="编辑器功能">
      <button type="button" className={mode === "files" ? "is-active" : ""} title="文件（Ctrl / ⌘ + P）" aria-label="源码文件" onClick={() => { setMode("files"); setQuickOpen(false); }}><FileTextOutlined /></button>
      <button type="button" className={mode === "search" ? "is-active" : ""} title="搜索全部文件（Ctrl / ⌘ + Shift + F）" aria-label="搜索全部源码" onClick={() => { setMode("search"); setQuickOpen(false); }}><SearchOutlined /></button>
    </nav>
    <aside className="monaco-sidebar" aria-label={mode === "files" ? "源码文件列表" : "源码搜索结果"}>
      <div className="monaco-sidebar-heading">{mode === "files" ? "文件" : "搜索"}</div>
      {mode === "files" ? <>
        {quickOpen && <Input ref={fileInput} autoFocus aria-label="查找源码文件" placeholder="输入文件名" value={fileFilter} onChange={event => setFileFilter(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && filteredFiles[0]) switchFile(filteredFiles[0].path); if (event.key === "Escape") { setQuickOpen(false); editor.current?.focus(); } }} />}
        <div className="monaco-file-list">{(quickOpen ? filteredFiles : files).map(file => <button type="button" key={file.path} className={filePath === file.path ? "is-active" : ""} title={file.path} onClick={() => switchFile(file.path)}><FileTextOutlined /><span>{file.path}</span></button>)}</div>
      </> : <>
        <Input ref={searchInput} autoFocus aria-label="搜索全部源码文件" placeholder="搜索全部源码文件" allowClear value={query} onChange={event => setQuery(event.target.value)} />
        <div className="monaco-search-summary" aria-live="polite">{query ? matches.length ? `${matches.length === 1000 ? "1000+" : matches.length} 个匹配` : "没有匹配结果" : "输入关键词搜索"}</div>
        <div className="monaco-search-results">{matches.map(match => <button type="button" key={`${match.file}:${match.line}:${match.column}`} onClick={() => selectMatch(match)} title={`${match.file}:${match.line}`}><span>{match.file}:{match.line}</span><code>{sourceLines.get(match.file)?.[match.line - 1]?.trim()}</code></button>)}</div>
      </>}
    </aside>
    <div className="monaco-main">
      <div className="monaco-file-tabs" role="tablist" aria-label="编辑器文件页签">{files.map(file => <button type="button" key={file.path} role="tab" aria-selected={filePath === file.path} className={filePath === file.path ? "is-active" : ""} title={file.path} onClick={() => switchFile(file.path)}>{file.path}</button>)}<button className="monaco-find-button" type="button" aria-label="查找当前文件" title="查找当前文件（Ctrl / ⌘ + F）" onClick={findInFile}><SearchOutlined /></button></div>
      <div className="monaco-editor-host" ref={host} />
      <div className="monaco-status-bar"><span>{filePath}</span><span>只读 · {language(filePath)} · {files.find(file => file.path === filePath)?.code.split("\n").length ?? 0} 行</span></div>
    </div>
  </div>;
}
