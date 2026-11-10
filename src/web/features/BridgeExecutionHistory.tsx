import type { BridgeExecutionRecord } from "../../web-bridge/history";
import { pretty, useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";

export function BridgeExecutionHistory({ application, toolId, disabled, onReuse }: { application: string; toolId: string; disabled: boolean; onReuse: (record: BridgeExecutionRecord) => void }) {
  const history = useResource<{ items: BridgeExecutionRecord[] }>(`/web-bridge/applications/${encodeURIComponent(application)}/tools/${encodeURIComponent(toolId)}/history`);
  return <section className="bridge-execution-history" aria-label="执行历史">
    <div className="bridge-toolbar"><strong>执行历史</strong><Button size="sm" variant="outline" onClick={history.reload}>刷新历史</Button></div>
    <p className="field-hint">包含正式调用和测试执行，显示本机保留的最近 100 条记录（总计最多保留 500 条）。载入参数后需手动执行，使用当前已保存的工具定义；字典引用会恢复并重新解析，Schema 禁止记录的手动值需要补填。</p>
    <ErrorNotice message={history.error} />
    {!history.data && !history.error && <Loading />}
    {history.data && !history.data.items.length && <p className="field-hint">暂无执行记录</p>}
    {history.data?.items.map(record => <details className="bridge-history-record" key={record.id}>
      <summary><time dateTime={new Date(record.startedAt).toISOString()}>{new Date(record.startedAt).toLocaleString("zh-CN")}</time> · {record.source === "test" ? "测试" : "调用"} · {record.status === "succeeded" ? "成功" : "失败"} · {record.durationMs} ms</summary>
      <div className="bridge-history-detail">
        <p className="field-hint">环境：{record.environmentId ?? "自动选择"}{record.errorCode ? ` · 错误：${record.errorCode}` : ""}</p>
        {record.definitionChanged && <p className="field-hint">工具定义已变化，再次执行使用当前定义及 Schema。</p>}
        {record.legacy && <p className="field-hint">旧历史缺少完整来源信息，无法自动还原的凭据需重新选择。</p>}
        {record.redacted && <p className="field-hint">部分手动值未记录；以下占位仅表示缺失，不会作为参数提交。</p>}
        {[{ label: "参数", sources: record.argSources }, { label: "调用凭据", sources: record.credentialSources }].map(group => Object.entries(group.sources ?? {}).map(([path, source]) => <p className="field-hint" key={`${group.label}:${path}`}>
          {group.label} <code>{path || "（根节点）"}</code>：{source.source === "dictionary" ? <code>{`{{dictionary:${source.dictionaryId}:${source.key}}}`}</code> : source.reason === "legacy-unknown" ? "[来源未知，需重新选择或填写]" : "[按 Schema 策略未记录，需重新填写]"}
        </p>))}
        <pre className="bridge-test-result">{pretty({ args: record.args, argSources: record.argSources, credentialValues: record.credentialValues, credentialSources: record.credentialSources })}</pre>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => onReuse(record)}>载入参数并前往测试</Button>
      </div>
    </details>)}
  </section>;
}
