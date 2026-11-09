import { Breadcrumbs } from "../components/common";
import { ConfigGitSettings } from "./ConfigGitSettings";

export function SettingsPage() {
  return <>
    <div className="page-heading"><Breadcrumbs items={[{ label: "设置" }, { label: "Git 仓库配置" }]} /></div>
    <section className="settings-content"><ConfigGitSettings /></section>
  </>;
}
