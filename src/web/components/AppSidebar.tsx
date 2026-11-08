import { useEffect, useRef, useState } from "react";
import { ChevronDown, Code2, GitBranch, Globe, Leaf, ListChecks, Menu, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./ui/dialog";
import { ThemePicker } from "../lib/theme";

export function AppSidebar({ section }: { section: string }) {
  const workflowActive = !["scripts", "web-bridge", "settings"].includes(section);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("orchard.sidebar.collapsed") === "true"; } catch { return false; }
  });
  const [expanded, setExpanded] = useState(!collapsed), [mobileOpen, setMobileOpen] = useState(false);
  const flyout = useRef<HTMLDivElement>(null);
  const toggleCollapsed = () => {
    const next = !collapsed;
    try { localStorage.setItem("orchard.sidebar.collapsed", String(next)); } catch {}
    setCollapsed(next); setExpanded(!next);
  };
  useEffect(() => {
    if (!collapsed || !expanded || mobileOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!flyout.current?.contains(event.target as Node)) setExpanded(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [collapsed, expanded, mobileOpen]);
  const navigation = (compact: boolean) => <nav className="sidebar-nav" aria-label="主导航">
    <div ref={compact ? flyout : undefined} className={`sidebar-workflows ${workflowActive ? "is-current" : ""}`}>
      <button type="button" className="sidebar-link sidebar-group" aria-label="工作流" title="工作流" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <GitBranch size={18} /><span className="sidebar-label">工作流</span><ChevronDown size={14} className={`sidebar-chevron ${expanded ? "" : "is-closed"}`} />
      </button>
      {expanded && <div className={`sidebar-submenu ${compact ? "sidebar-flyout" : ""}`}>
        <a href="/" className={workflowActive && section !== "runs" ? "active" : ""} aria-current={workflowActive && section !== "runs" ? "page" : undefined} onClick={() => setMobileOpen(false)}><GitBranch size={15} />工作流定义</a>
        <a href="/runs" className={section === "runs" ? "active" : ""} aria-current={section === "runs" ? "page" : undefined} onClick={() => setMobileOpen(false)}><ListChecks size={15} />运行记录</a>
      </div>}
    </div>
    {[{ href: "/scripts", label: "脚本库", icon: Code2, key: "scripts" }, { href: "/web-bridge", label: "网页桥接", icon: Globe, key: "web-bridge" }].map(item =>
      <a key={item.key} href={item.href} title={item.label} aria-label={item.label} className={`sidebar-link ${section === item.key ? "active" : ""}`} aria-current={section === item.key ? "page" : undefined} onClick={() => setMobileOpen(false)}><item.icon size={18} /><span className="sidebar-label">{item.label}</span></a>)}
  </nav>;
  const footer = <div className="sidebar-footer">
    <a href="/settings" className={`sidebar-link ${section === "settings" ? "active" : ""}`} title="设置" aria-label="设置" aria-current={section === "settings" ? "page" : undefined} onClick={() => setMobileOpen(false)}><Settings2 size={18} /><span className="sidebar-label">设置</span></a>
    <div className="sidebar-preferences"><span className="local-indicator"><i />本地</span><ThemePicker label="侧栏外观" /></div>
  </div>;
  return <>
    <aside className={`app-sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="侧栏">
      <div className="sidebar-brand"><a href="/" className="brand" aria-label="orchard"><Leaf size={21} /><span>orchard</span></a><Button variant="ghost" size="icon" aria-label={collapsed ? "展开侧栏" : "折叠侧栏"} onClick={toggleCollapsed}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</Button></div>
      {navigation(collapsed)}{footer}
    </aside>
    <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
      <DialogTrigger asChild><Button variant="outline" size="icon" className="mobile-menu-trigger" aria-label="打开菜单" onClick={() => setExpanded(true)}><Menu size={19} /></Button></DialogTrigger>
      <DialogContent className="mobile-sidebar"><DialogTitle>orchard</DialogTitle><DialogDescription className="sr-only">主导航菜单</DialogDescription>{navigation(false)}{footer}</DialogContent>
    </Dialog>
  </>;
}
