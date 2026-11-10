import type { AgentModelConfigView, ProviderView } from "../../domain/types.js";
import type { GitProject } from "../../project-git/types.js";
import { useResource } from "../lib/api";
import { ErrorNotice } from "../components/common";

export function ProjectContextPicker({ value, config, disabled, onChange }: { value?: string; config?: AgentModelConfigView; disabled: boolean; onChange: (id: string) => void }) {
  const projects = useResource<{ items: GitProject[] }>("/git-projects");
  const providers = useResource<{ items: ProviderView[] }>("/providers");
  const selected = projects.data?.items?.find(p => p.id === value);
  const provider = providers.data?.items?.find(p => p.id === config?.providerId);
  return <div className="field"><label htmlFor="agent-project">项目上下文（可选）</label>
    <select id="agent-project" className="project-select" value={value ?? ""} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">无项目（沿用普通 Agent 行为）</option>
      {value && !selected && <option value={value} disabled>{value}（本机项目缺失）</option>}
      {projects.data?.items?.map(project => <option key={project.id} value={project.id} disabled={!project.enabled}>{project.name} · {project.branch}{project.enabled ? "" : "（已禁用）"}</option>)}
    </select>
    <ErrorNotice message={projects.error || providers.error} />
    {value && <><p className="field-hint">分支：{selected?.branch ?? "不可用"} · Provider：{provider?.capabilities.projectAnalysis ? "支持项目分析" : "未选择或不支持项目分析"}</p><p className="field-hint">源码可能发送给所选模型。Agent 可执行命令并修改本机文件；独立目录不构成安全沙箱，Orchard 不保证阻止 push。</p></>}
  </div>;
}
