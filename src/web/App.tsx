import { Component, type ReactNode } from "react";
import { Code2, GitBranch, Leaf, ListChecks, Settings2 } from "lucide-react";
import { ScriptPage, ScriptsPage } from "./features/ScriptPages";
import { WorkflowsPage, WorkflowPage } from "./features/WorkflowPages";
import { DraftPage } from "./features/DraftPage";
import { RunPage, RunsPage } from "./features/RunPages";
import { SettingsPage } from "./features/SettingsPage";
import { ConfigGitGeneralDelivery } from "./features/ConfigGitSettings";
import { ErrorNotice } from "./components/common";
import { ThemePicker } from "./lib/theme";
import { BootstrapGate } from "./Bootstrap";
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="panel"><h1>页面暂时无法展示</h1><ErrorNotice message={this.state.error} /><a href="/">返回工作流列表 →</a></div> : this.props.children; }
}
export default function App() { return <BootstrapGate><BusinessApp /></BootstrapGate>; }
export function BusinessApp() {
  const path = window.location.pathname, parts = path.split("/").filter(Boolean), studio = parts[0] === "drafts";
  const page = parts[0] === "scripts" ? parts[1] ? <ScriptPage key={parts[1]} id={parts[1]} /> : <ScriptsPage /> : parts[0] === "settings" ? <SettingsPage /> : parts[0] === "drafts" && parts[1] ? <DraftPage key={parts[1]} id={parts[1]} /> : parts[0] === "workflows" && parts[1] ? <WorkflowPage key={parts[1]} id={parts[1]} /> : parts[0] === "runs" && parts[1] ? <RunPage key={parts[1]} id={parts[1]} /> : parts[0] === "runs" ? <RunsPage /> : <WorkflowsPage />;
  return <div className={`app-shell ${studio ? "studio-shell" : ""} ${parts[0] === "scripts" && parts[1] ? "script-shell" : ""}`}>
    <header className="app-header">
      <a href="/" className="brand"><Leaf size={21} /><span>orchard</span></a>
      <nav className="app-nav" aria-label="主导航">
        {[{ href: "/", label: "工作流", icon: GitBranch, active: !["scripts", "runs", "settings"].includes(parts[0] ?? "") },
          { href: "/scripts", label: "脚本库", icon: Code2, active: parts[0] === "scripts" },
          { href: "/runs", label: "运行记录", icon: ListChecks, active: parts[0] === "runs" },
          { href: "/settings", label: "设置", icon: Settings2, active: parts[0] === "settings" }].map(item =>
          <a key={item.href} href={item.href} className={item.active ? "active" : ""} aria-current={item.active ? "page" : undefined}>
            <item.icon size={15} /><span>{item.label}</span>
          </a>)}
      </nav>
      <div className="header-actions"><span className="local-indicator"><i />本地</span><ThemePicker /></div>
    </header>
    <main className="app-main"><ErrorBoundary><ConfigGitGeneralDelivery />{page}</ErrorBoundary></main>
  </div>;
}
