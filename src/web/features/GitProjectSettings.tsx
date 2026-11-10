import { useEffect, useState } from "react";
import type { GitProject, ProjectOperation } from "../../project-git/types.js";
import { PROJECT_RISK_VERSION } from "../../project-git/types.js";
import { api, send, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ErrorNotice, Loading } from "../components/common";

export function GitProjectSettings() {
  const resource = useResource<{ items: GitProject[] }>("/git-projects");
  const profiles = useResource<{ items: { id: string; name: string; state: string }[] }>("/git-ssh-profiles");
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState("");
  return <div className="detail-stack">
    <div className="settings-section-heading"><strong>项目仓库</strong><Button size="sm" variant="outline" onClick={() => setSelected("")}>新建项目</Button></div>
    <ErrorNotice message={error || resource.error || profiles.error} />
    <p className="field-hint">每个项目绑定本机 SSH 档案。没有自动推送操作，也不保证 Agent 无法推送。</p>
    <div className="project-settings-grid">
      <nav className="project-list" aria-label="项目仓库">{resource.data?.items.map(project => <button key={project.id} aria-current={selected === project.id ? "page" : undefined} onClick={() => setSelected(project.id)}><strong>{project.name}</strong><span>{project.enabled ? "已启用" : "已禁用"} · {project.branch}</span></button>)}{!resource.data && <Loading />}{resource.data?.items.length === 0 && <p className="field-hint">尚无项目</p>}</nav>
      {selected !== null ? <ProjectForm key={`${selected}:${resource.data?.items.find(p => p.id === selected)?.revision ?? 0}`} current={resource.data?.items.find(p => p.id === selected)} profiles={profiles.data?.items ?? []} onSaved={project => { setSelected(project.id); resource.reload(); }} onError={setError} /> : <p className="field-hint">选择项目查看详情，或新建项目。</p>}
    </div>
    <details><summary>本机 SSH 档案配置方法</summary><p className="field-hint">“本机”指运行 Orchard 服务的主机。在实际数据目录的 project-git/ssh-profiles.json 中由管理员维护档案数组，权限设为 0600；SSH 私钥不通过网页上传。档案增删改时递增 revision。通过可信渠道核对主机指纹并维护 known_hosts，加密私钥须预先解锁到服务可访问的 ssh-agent。</p><pre className="project-help">{JSON.stringify([{ id: "git-host", name: "Git 主机", host: "git.example.com", port: 22, user: "git", identityFile: "/absolute/path/to/private-key", knownHostsFile: "/absolute/path/to/known_hosts", useAgent: false, revision: 1 }], null, 2)}</pre><p className="field-hint">私钥须为运行账户所有的普通文件，仅账户本人可读写，父目录不得允许组或其他用户写入。未知或变化的主机指纹会阻止连接。档案页面只返回名称与安全状态。参见设置“存储空间”中的实际数据目录。</p></details>
  </div>;
}
function ProjectForm({ current, profiles, onSaved, onError }: { current?: GitProject; profiles: { id: string; name: string; state: string }[]; onSaved: (project: GitProject) => void; onError: (error: string) => void }) {
  const [value, setValue] = useState<GitProject>(current ?? { id: "", name: "", remoteUrl: "", branch: "main", sshProfileId: "", enabled: false, revision: 0 });
  const [accepted, setAccepted] = useState(current?.acceptedRiskVersion === PROJECT_RISK_VERSION), [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(""), [operation, setOperation] = useState<ProjectOperation | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!operationId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { const next = await api<ProjectOperation>(`/git-project-operations/${operationId}`); if (cancelled) return; setOperation(next); if (next.status === "running") timer = setTimeout(() => void poll(), 800); } catch (error) { if (!cancelled) onError((error as Error).message); } };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [operationId]);
  const update = (key: keyof GitProject, next: string | boolean) => setValue(previous => ({ ...previous, [key]: next }));
  const save = async () => {
    setBusy(true); onError("");
    try { const project = await api<GitProject>(current ? `/git-projects/${current.id}` : "/git-projects", { method: current ? "PATCH" : "POST", body: JSON.stringify({ ...value, ...(accepted ? { acceptedRiskVersion: PROJECT_RISK_VERSION } : {}) }) }); setNotice("项目已保存"); onSaved(project); }
    catch (error) { onError((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="detail-stack" aria-label="项目详情" aria-busy={busy}>
    {([ ["id", "项目 ID"], ["name", "项目名称"], ["remoteUrl", "SSH Git 地址"], ["branch", "分支"] ] as const).map(([key, label]) => <div className="field" key={key}><label htmlFor={`project-${key}`}>{label}</label><Input id={`project-${key}`} value={value[key]} disabled={busy || key === "id" && !!current} onChange={event => update(key, event.target.value)} /></div>)}
    <div className="field"><label htmlFor="project-profile">SSH 档案</label><select id="project-profile" className="project-select" value={value.sshProfileId} disabled={busy} onChange={event => update("sshProfileId", event.target.value)}><option value="">请选择本机 SSH 档案</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.state === "available" ? "文件可用" : "需检查"}</option>)}</select></div>
    <label className="project-checkbox"><input type="checkbox" checked={value.enabled} disabled={busy} onChange={event => update("enabled", event.target.checked)} />启用项目</label>
    <label className="project-checkbox"><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} />我接受：Agent 可执行命令、修改本机文件并访问凭据；Orchard 不保证阻止 push；源码可能发送给所选模型服务。</label>
    <div className="actions"><Button size="sm" disabled={busy || value.enabled && !accepted} onClick={() => void save()}>保存项目</Button><Button size="sm" variant="outline" disabled={!current || busy || operation?.status === "running"} onClick={async () => { onError(""); try { const result = await send<{ operationId: string }>(`/git-projects/${current!.id}/check`); setOperationId(result.operationId); } catch (error) { onError((error as Error).message); } }}>检测已保存配置</Button></div>
    <p role="status" className="field-hint">{notice}{operation && ` 检测${operation.status === "running" ? "中…" : operation.status === "completed" ? "成功" : "失败"} ${operation.error?.message ?? ""}`}</p>
    {operation?.branches && <p className="field-hint project-wrap">远端分支：{operation.branches.join("、")}</p>}
  </section>;
}
