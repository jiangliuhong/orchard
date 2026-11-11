import { useState } from "react";
import type { AgentKnowledgeSettings as KnowledgeView } from "../../agent/settings";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { useResource } from "../lib/api";

export function AgentKnowledgeSettings() {
  const { data, error, reload } = useResource<KnowledgeView>("/settings/agent-knowledge");
  const [selected, setSelected] = useState("AGENTS.md");
  const file = data?.files.find(file => file.path === selected) ?? data?.files[0];
  return <section className="agent-knowledge" aria-label="Agent 内置知识">
    <div className="settings-section-heading"><span>内置知识 · 只读</span><Button variant="ghost" size="sm" onClick={reload}>刷新</Button></div>
    <ErrorNotice message={error} />
    {!data && !error && <Loading />}
    {data && <>
      <p className="field-hint" role="status">{data.runtime.reason}</p>
      <dl className="agent-knowledge-meta"><dt>版本</dt><dd>{data.bundleVersion}</dd><dt>知识 hash</dt><dd><code>{data.hash}</code></dd><dt>契约 / 工具策略</dt><dd><code>{data.contractVersion} / {data.toolPolicyVersion}</code></dd></dl>
      <div className="agent-knowledge-workspace panel">
        <nav aria-label="内置知识文件">{data.files.map(item => <button key={item.path} type="button" aria-current={file?.path === item.path ? "page" : undefined} onClick={() => setSelected(item.path)}>{item.path}</button>)}</nav>
        <div className="agent-knowledge-document"><div className="agent-knowledge-path"><code>{file?.path}</code></div><pre tabIndex={0} aria-label={`只读知识内容：${file?.path ?? ""}`}><code>{file?.content}</code></pre></div>
      </div>
      <p className="field-hint">知识随安装包发布，不提供编辑、覆盖或恢复默认操作。</p>
    </>}
  </section>;
}
