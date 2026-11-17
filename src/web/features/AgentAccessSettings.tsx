import { useState } from "react";
import { Copy, RefreshCw } from "lucide-react";
import type { AgentPolicy, Channel } from "../../external-agent/policy";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { send, useResource } from "../lib/api";

type Card = { id: string; name: string; note: string; revision: number; available: boolean; confirmation: boolean; kind: "script" | "browser_tool" };
type Settings = { policy: AgentPolicy; cards: Card[]; installation: { command: string; args: string[] } };
const path = "/settings/agent-access";
const clients = ["Claude Code", "Cursor", "VS Code", "Codex"] as const;
type Client = typeof clients[number];

function configFor(client: Client, { command, args }: Settings["installation"]) {
  const stdio = { type: "stdio", command, args };
  switch (client) {
    case "Codex": return `[mcp_servers.orchard]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`;
    case "VS Code": return JSON.stringify({ servers: { orchard: stdio } }, null, 2);
    case "Claude Code": return JSON.stringify({ mcpServers: { orchard: stdio } }, null, 2);
    case "Cursor": return JSON.stringify({ mcpServers: { orchard: { command, args } } }, null, 2);
  }
}

export function AgentAccessSettings() {
  const { data, error, reload } = useResource<Settings>(path);
  if (!data) return error ? <><ErrorNotice message={error} /><Button onClick={reload}>重试</Button></> : <Loading />;
  return <><ErrorNotice message={error} /><AgentAccessForm key={data.policy.revision} settings={data} reload={reload} /></>;
}

function AgentAccessForm({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [policy, setPolicy] = useState(settings.policy);
  const [saved, setSaved] = useState(settings.policy);
  const [saveNotice, setSaveNotice] = useState("");
  const [clientsTab, setClientsTab] = useState<Client>("Claude Code");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const config = configFor(clientsTab, settings.installation);
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);
  const update = (channel: Channel, change: Partial<AgentPolicy[Channel]>) => {
    setPolicy(current => ({ ...current, [channel]: { ...current[channel], ...change } }));
    setSaveNotice("");
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await send<Settings>(path, policy, "PUT");
      setPolicy(next.policy);
      setSaved(next.policy);
      setSaveNotice("权限已保存");
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(config); setNotice("已复制安装配置"); }
    catch { setNotice("无法访问剪贴板，请选中配置文本后复制。"); }
  };
  const candidates = settings.cards.filter(card => `${card.name} ${card.note}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="agent-access-settings">
    <section className="panel" aria-label="调用权限">
      <h2>调用权限</h2>
      <p className="field-hint">选择已配置的快速执行卡片。卡片使用保存的参数，修改卡片后需要重新授权。</p>
      <div className="agent-access-actions">
        {(["mcp", "cli"] as const).map(channel => <label key={channel}>
          <input type="checkbox" checked={policy[channel].enabled} disabled={busy}
            onChange={event => update(channel, { enabled: event.target.checked })} /> 启用 {channel.toUpperCase()}
        </label>)}
        <Button size="sm" variant="outline" aria-label="刷新卡片与权限" disabled={busy || dirty} onClick={reload}><RefreshCw size={14} /></Button>
      </div>
      <label className="sr-only" htmlFor="agent-access-search">搜索卡片</label>
      <input id="agent-access-search" className="agent-access-search" type="search" placeholder="搜索卡片" value={query} onChange={event => setQuery(event.target.value)} />
      {candidates.length ? <table className="agent-access-table">
        <thead><tr><th scope="col">快速执行卡片</th><th scope="col">MCP</th><th scope="col">CLI</th></tr></thead>
        <tbody>{candidates.map(card => <tr key={card.id}>
          <th scope="row">
            <span className="agent-access-card-name" title={card.name}>{card.name}</span>
            <span className="field-hint">{card.kind === "script" ? "脚本" : "网页工具"}{!card.available ? " · 不可用" : card.confirmation ? " · 需在工作台确认" : ""}</span>
          </th>
          {(["mcp", "cli"] as const).map(channel => {
            const grant = policy[channel].cards.find(item => item.id === card.id);
            const checked = grant?.revision === card.revision;
            return <td key={channel}><label>
              <input type="checkbox" checked={checked} disabled={busy || ((!card.available || card.confirmation) && !checked)}
                aria-label={`${card.name} · ${channel.toUpperCase()}`}
                onChange={event => {
                  const cards = policy[channel].cards.filter(item => item.id !== card.id);
                  if (event.target.checked) cards.push({ id: card.id, revision: card.revision });
                  update(channel, { cards });
                }} />
              {grant && !checked && <span className="field-hint agent-access-stale">需重授权</span>}
            </label></td>;
          })}
        </tr>)}</tbody>
      </table> : <p className="field-hint">{query ? "没有匹配的卡片。" : "暂无可选卡片。请先在快速执行页面添加脚本或网页工具卡片。"}</p>}
      <ErrorNotice message={error} />
      <div className="agent-access-actions"><Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存权限"}</Button><span role="status" className="field-hint">{saveNotice}</span></div>
    </section>
    <section className="panel" aria-label="MCP 安装配置">
      <h2>MCP 安装配置</h2>
      <p className="field-hint">复制到同一台电脑上的 Agent 配置。Agent 调用时会按需启动 Orchard 服务。</p>
      <div className="agent-access-actions" role="group" aria-label="选择 Agent 客户端">
        {clients.map(client => <Button key={client} size="sm" variant={clientsTab === client ? "secondary" : "ghost"}
          aria-pressed={clientsTab === client} onClick={() => { setClientsTab(client); setNotice(""); }}>{client}</Button>)}
      </div>
      <div className="agent-access-config">
        <pre tabIndex={0} aria-label={`${clientsTab} MCP 安装配置`}><code>{config}</code></pre>
        <Button size="sm" variant="outline" aria-label="复制安装配置" onClick={() => void copy()}><Copy size={14} /> 复制</Button>
      </div>
      <p className="field-hint" role="status">{notice}</p>
    </section>
  </div>;
}
