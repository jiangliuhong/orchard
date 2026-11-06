import { useState } from "react";
import type { ScriptView, WorkflowNode } from "../../domain/types.js";
import { useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { ErrorNotice, Payload } from "../components/common";
import type { ScriptDetail } from "./ScriptPages";

export function ScriptNodePicker({ node, disabled, onApply }: { node: WorkflowNode; disabled: boolean; onApply: (node: WorkflowNode) => void }) {
  const [query, setQuery] = useState(""), [scriptId, setScriptId] = useState(node.config.scriptId ?? "");
  const scripts = useResource<{ items: ScriptView[] }>(`/scripts?limit=200&q=${encodeURIComponent(query)}`);
  return <div className="detail-stack"><h3>引用脚本库</h3><input aria-label="搜索可用脚本" placeholder="搜索脚本名称或 ID" value={query} disabled={disabled} onChange={event => setQuery(event.target.value)} />
    <ErrorNotice message={scripts.error} /><label htmlFor={`script-picker-${node.id}`}>脚本</label><select id={`script-picker-${node.id}`} value={scriptId} disabled={disabled} onChange={event => setScriptId(event.target.value)}><option value="">选择已发布脚本</option>{scriptId && !scripts.data?.items.some(script => script.id === scriptId) && <option value={scriptId}>{scriptId}</option>}{scripts.data?.items.filter(script => script.currentPublishedVersionId && script.status !== "archived").map(script => <option value={script.id} key={script.id}>{script.name} · {script.runtime}</option>)}</select>
    {scriptId && <ScriptVersionPicker key={scriptId} scriptId={scriptId} node={node} disabled={disabled} onApply={onApply} />}
    {node.config.scriptId && <a href={`/scripts/${node.config.scriptId}`}>查看引用的脚本 →</a>}
  </div>;
}

function ScriptVersionPicker({ scriptId, node, disabled, onApply }: { scriptId: string; node: WorkflowNode; disabled: boolean; onApply: (node: WorkflowNode) => void }) {
  const script = useResource<ScriptDetail>(`/scripts/${scriptId}`);
  const [selected, setSelected] = useState(node.config.scriptId === scriptId ? node.config.scriptVersionId ?? "" : "");
  const versionId = selected || script.data?.currentPublishedVersionId;
  const version = script.data?.versions.find(version => version.id === versionId);
  return <><ErrorNotice message={script.error} /><label htmlFor={`script-version-${node.id}`}>固定发布版本</label><select id={`script-version-${node.id}`} disabled={disabled} value={versionId ?? ""} onChange={event => setSelected(event.target.value)}><option value="">选择版本</option>{script.data?.versions.filter(version => version.status === "published").map(version => <option key={version.id} value={version.id}>v{version.number}{version.id === script.data?.currentPublishedVersionId ? " · 最新发布" : ""}</option>)}</select>
    {node.config.scriptId === scriptId && node.config.scriptVersionId && script.data?.currentPublishedVersionId !== node.config.scriptVersionId && <div className="notice">此节点使用历史版本，更新引用需要应用后保存工作流草稿。</div>}
    {version && <><label>脚本输入 Schema</label><Payload value={version.inputSchema} /><label>脚本输出 Schema</label><Payload value={version.outputSchema} /><Button variant="outline" disabled={disabled || script.data?.status === "archived"} onClick={() => onApply({ ...node, type: "script", config: { scriptId, scriptVersionId: version.id, ...(node.config.timeoutMs === undefined ? {} : { timeoutMs: Math.min(node.config.timeoutMs, version.timeoutMs) }) }, outputSchema: version.outputSchema })}>应用此脚本版本</Button><span className="field-hint">保留节点输入绑定及更短的超时，使用脚本输出 Schema。发布新脚本版本不会自动更新此引用。</span></>}
  </>;
}
