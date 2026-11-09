import { useState } from "react";
import { Braces, ChevronDown, FileCode2, GitBranch, Globe, Info, LockKeyhole, Terminal } from "lucide-react";
import { useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Textarea } from "../components/ui/textarea";

interface PromptPreview {
  id: string; name: string; prompt: string; schema: unknown; contextNote: string;
}
const agentStyles = {
  workflow: { icon: GitBranch, description: "图编排与节点规则" },
  "web-bridge": { icon: Globe, description: "工具定义与平台契约" },
  script: { icon: Terminal, description: "脚本编写与执行约定" },
};

export function AgentPromptPreview() {
  const { data, error } = useResource<{ items: PromptPreview[] }>("/settings/agent-prompts");
  const [selected, setSelected] = useState("workflow");
  const item = data?.items.find(item => item.id === selected);
  return <section className="agent-prompt-preview">
    <header className="prompt-preview-heading">
      <div className="prompt-preview-heading-icon"><FileCode2 size={22} /></div>
      <div><h2>Agent 默认系统提示词</h2><p>查看系统如何定义 Agent 的职责、规则与输出格式。</p></div>
      <span className="prompt-preview-badge"><LockKeyhole size={12} />只读预览</span>
    </header>
    <ErrorNotice message={error} />
    {!data && !error && <Loading />}
    {data && <div className="prompt-agent-switcher" role="group" aria-label="Agent 类型">{data.items.map(entry => {
      const style = agentStyles[entry.id as keyof typeof agentStyles];
      const Icon = style?.icon ?? FileCode2;
      return <button key={entry.id} className="prompt-agent-option" aria-label={entry.name} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>
        <span className="prompt-agent-icon"><Icon size={19} /></span>
        <span><strong>{entry.name}</strong><small>{style?.description ?? "默认规则"}</small></span>
        <span className="prompt-agent-indicator" aria-hidden="true" />
      </button>;
    })}</div>}
    {item && <div className="prompt-preview-body" key={item.id}>
      <aside className="prompt-context-note"><Info size={16} /><div><strong>运行时上下文</strong><p>{item.contextNote}</p></div></aside>
      <section className="prompt-code-panel" aria-label={`${item.name}提示词预览`}>
        <header className="prompt-code-toolbar">
          <label htmlFor="agent-default-prompt"><FileCode2 size={15} />{item.name}默认提示词</label>
          <span>{item.prompt.split("\n").length} 行<span className="prompt-code-divider">/</span>纯文本</span>
        </header>
        <Textarea id="agent-default-prompt" readOnly value={item.prompt} rows={20} className="prompt-code-text" spellCheck={false} />
      </section>
      <details className="prompt-schema-panel">
        <summary><Braces size={17} /><span>结构化输出 Schema<small>模型回复必须遵循的 JSON 格式</small></span><span className="prompt-schema-format">JSON</span><ChevronDown size={16} className="prompt-schema-chevron" /></summary>
        <Textarea aria-label={`${item.name}输出 Schema`} readOnly value={JSON.stringify(item.schema, null, 2)} rows={16} className="prompt-code-text" spellCheck={false} />
      </details>
    </div>}
    <footer className="prompt-preview-footnote"><LockKeyhole size={13} /><p>与实际调用共用默认规则，不含真实会话、凭据或应用数据，也不包含 Provider 自身的内置提示词。当前规则由宿主拼入请求，并非独立 system 消息。</p></footer>
  </section>;
}
