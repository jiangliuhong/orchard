import { useNavigation } from "./lib/navigation";
import { Component, useCallback, useState, type ReactNode } from "react";
import { ScriptPage, ScriptsPage } from "./features/ScriptPages";
import { WorkflowsPage, WorkflowPage } from "./features/WorkflowPages";
import { DraftPage } from "./features/DraftPage";
import { RunPage, RunsPage } from "./features/RunPages";
import { DictionariesPage, DictionaryPage } from "./features/DictionariesPage";
import { SettingsPage } from "./features/SettingsPage";
import { ConfigGitGeneralDelivery } from "./features/ConfigGitSettings";
import { ErrorNotice } from "./components/common";
import { AppSidebar } from "./components/AppSidebar";
import { WebBridgeSettings } from "./features/WebBridgeSettings";
import { BootstrapGate } from "./Bootstrap";
import { BrowserNotifications } from "./lib/notifications";
class ErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <div className="panel"><h1>页面暂时无法展示</h1><ErrorNotice message={this.state.error} /><a href="/">返回工作流列表 →</a></div> : this.props.children; }
}
export default function App() { return <BootstrapGate><BusinessApp /></BootstrapGate>; }
export function BusinessApp() {
  const [route, setRoute] = useState(() => window.location.pathname + window.location.search);
  useNavigation(useCallback(() => {
    setRoute(window.location.pathname + window.location.search);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []));
  const path = route.split("?")[0]!, parts = path.split("/").filter(Boolean), studio = parts[0] === "drafts";
  const page = parts[0] === "dictionaries" ? parts[1] ? <DictionaryPage key={parts[1]} id={parts[1]} /> : <DictionariesPage /> : parts[0] === "web-bridge" ? <WebBridgeSettings /> : parts[0] === "scripts" ? parts[1] ? <ScriptPage key={parts[1]} id={parts[1]} /> : <ScriptsPage /> : parts[0] === "settings" ? <SettingsPage /> : parts[0] === "drafts" && parts[1] ? <DraftPage key={parts[1]} id={parts[1]} /> : parts[0] === "workflows" && parts[1] ? <WorkflowPage key={parts[1]} id={parts[1]} /> : parts[0] === "runs" && parts[1] ? <RunPage key={parts[1]} id={parts[1]} /> : parts[0] === "runs" ? <RunsPage /> : <WorkflowsPage />;
  return <div className={`app-shell ${studio ? "studio-shell" : ""} ${parts[0] === "settings" ? "settings-shell" : ""} ${parts[0] === "scripts" && parts[1] ? "script-shell" : ""} ${parts[0] === "web-bridge" ? "bridge-shell" : ""} ${parts[0] === "dictionaries" && parts[1] ? "dictionary-shell" : ""}`}>
    <AppSidebar section={parts[0] ?? ""} />
    <main className="app-main"><ConfigGitGeneralDelivery /><BrowserNotifications /><ErrorBoundary key={path === "/runs" ? path : route}>{page}</ErrorBoundary></main>
  </div>;
}
