import { lazy, Suspense, useState } from "react";
import { FileCode2, FileJson, FolderCode, Maximize2, Minimize2, Terminal } from "lucide-react";
import type { SourceFiles } from "../../domain/types.js";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Loading } from "../components/common";

const CodeEditor = lazy(() => import("./CodeEditor"));

export function SourceFileList({ paths, selected, onSelect }: { paths: string[]; selected: string; onSelect: (path: string) => void }) {
  return <nav className="source-file-list" aria-label="源码文件列表">{paths.map(path => {
    const Icon = path.endsWith(".json") ? FileJson : path.endsWith(".sh") ? Terminal : FileCode2;
    return <button type="button" key={path} className={`source-file${path === selected ? " is-active" : ""}`} aria-current={path === selected ? "page" : undefined} title={path} onClick={() => onSelect(path)}><Icon size={15} /><span>{path}</span></button>;
  })}</nav>;
}

export function SourceTabs({ files, path, onPath, onChange }: {
  files: SourceFiles; path: string; onPath: (path: string) => void; onChange?: (value: string, path: string) => void;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const paths = Object.keys(files).sort((left, right) => {
    const rank = (name: string) => name === "workflow.json" ? 0 : name === "layout.json" ? 1 : 2;
    return rank(left) - rank(right) || left.localeCompare(right);
  });
  const selected = Object.hasOwn(files, path) ? path : paths[0];
  const editor = selected ? <Suspense fallback={<Loading />}><CodeEditor path={selected} value={files[selected] ?? ""} onChange={onChange ? value => onChange(value, selected) : undefined} /></Suspense> : <div className="empty">暂无源码文件</div>;
  return <div className="source-view"><div className="source-toolbar"><Select value={selected ?? ""} onValueChange={onPath}><SelectTrigger aria-label="选择源码文件"><SelectValue placeholder="选择文件" /></SelectTrigger><SelectContent>{paths.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><Dialog open={fullscreen} onOpenChange={setFullscreen}><DialogTrigger asChild><Button variant="outline" disabled={!paths.length} aria-label="全屏预览源码" title="全屏预览源码"><Maximize2 size={14} /><span>全屏预览</span></Button></DialogTrigger><DialogContent className="source-fullscreen translate-x-0 translate-y-0" showCloseButton={false}><header className="source-fullscreen-header"><div className="source-fullscreen-title"><FolderCode size={18} /><div><DialogTitle>源码全屏预览</DialogTitle><DialogDescription>{onChange ? "可编辑 · 修改与草稿同步，退出全屏后点击“保存修改”" : "只读 · 当前源码不可编辑"}</DialogDescription></div></div><Button variant="outline" onClick={() => setFullscreen(false)}><Minimize2 size={14} />退出全屏</Button></header><div className="source-fullscreen-body"><aside className="source-sidebar"><div className="source-sidebar-heading"><span>文件</span><span>{paths.length}</span></div><SourceFileList paths={paths} selected={selected ?? ""} onSelect={onPath} /></aside><section className="source-content" aria-label="源码内容"><div className="source-content-heading"><FileCode2 size={14} /><span title={selected}>{selected}</span><span className="source-mode">{onChange ? "可编辑" : "只读"}</span></div><div className="source-content-editor">{fullscreen && editor}</div></section></div></DialogContent></Dialog></div>{!fullscreen && editor}</div>;
}
