import { useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { BridgeExecutionRecord } from "../../web-bridge/history";
import { pretty, useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";

const executionTime = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function statusLabel(record: BridgeExecutionRecord) {
  return record.status === "succeeded" ? "成功" : "失败";
}

function sourceLabel(record: BridgeExecutionRecord) {
  return record.source === "test" ? "测试" : "正式调用";
}

export function BridgeExecutionHistory({ application, toolId, disabled, onReuse }: { application: string; toolId: string; disabled: boolean; onReuse: (record: BridgeExecutionRecord) => void }) {
  const history = useResource<{ items: BridgeExecutionRecord[] }>(`/web-bridge/applications/${encodeURIComponent(application)}/tools/${encodeURIComponent(toolId)}/history`);
  const [selectedId, setSelectedId] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const listScroll = useRef(0);
  const detailId = useId();
  const headingId = useId();
  const items = history.data?.items.toSorted((a, b) => b.startedAt - a.startedAt);
  const record = items?.find(item => item.id === selectedId);
  const isOpen = Boolean(record);

  useLayoutEffect(() => {
    if (isOpen) {
      close.current?.focus({ preventScroll: true });
    } else if (trigger.current) {
      if (list.current) list.current.scrollTop = listScroll.current;
      trigger.current.focus({ preventScroll: true });
      trigger.current = null;
    }
  }, [isOpen, selectedId]);

  return <section className="bridge-execution-history" aria-label="执行历史" onKeyDown={event => {
    if (event.key === "Escape" && record && !event.defaultPrevented) {
      event.stopPropagation();
      setSelectedId(undefined);
    }
  }}>
    <div className="bridge-toolbar bridge-history-toolbar">
      <div><strong>执行历史</strong><span className="field-hint">本机最近 100 条 · 总计最多保留 500 条</span></div>
      <Button size="sm" variant="outline" onClick={history.reload}>刷新历史</Button>
    </div>
    <ErrorNotice message={history.error} />
    {!history.data && !history.error && <Loading />}
    {items && !items.length && <p className="field-hint">暂无执行记录</p>}
    {Boolean(items?.length) && <div className={`bridge-history-workspace${record ? " has-detail" : ""}`}>
      <div className="bridge-history-list" ref={list}>
        <div className="bridge-history-row bridge-history-columns" aria-hidden="true">
          <span>执行时间 ↓</span><span>来源</span><span>状态</span><span>耗时</span><span />
        </div>
        <ul aria-label="执行记录">
          {items?.map(item => {
            const date = new Date(item.startedAt);
            const time = executionTime.format(date);
            const active = record?.id === item.id;
            return <li key={item.id}>
              <button type="button" className="bridge-history-row" aria-label={`${time} · ${sourceLabel(item)} · ${statusLabel(item)} · ${item.durationMs} ms`} aria-expanded={active} aria-controls={detailId} onClick={event => {
                trigger.current = event.currentTarget;
                listScroll.current = list.current?.scrollTop ?? 0;
                setSelectedId(item.id);
              }}>
                <time dateTime={date.toISOString()}>{time}</time>
                <span>{sourceLabel(item)}</span>
                <span className={`bridge-history-status status-${item.status}`}>{statusLabel(item)}</span>
                <span className="bridge-history-duration">{item.durationMs} ms</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </li>;
          })}
        </ul>
      </div>
      <section id={detailId} aria-labelledby={headingId} className="bridge-history-detail" hidden={!record}>
        {record && <>
          <header className="bridge-toolbar bridge-history-detail-header">
            <h3 id={headingId}>执行详情</h3>
            <Button ref={close} size="sm" variant="ghost" onClick={() => setSelectedId(undefined)}><ArrowLeft size={14} />返回列表</Button>
          </header>
          <div className="bridge-history-detail-body" key={record.id}>
            <div className="bridge-history-meta">
              <time dateTime={new Date(record.startedAt).toISOString()}>{executionTime.format(record.startedAt)}</time>
              <span>{sourceLabel(record)} · {statusLabel(record)} · {record.durationMs} ms</span>
              <span className="field-hint">环境：{record.environmentId ?? "自动选择"}</span>
            </div>
            {record.errorCode && <p className="bridge-history-error">错误代码：<code>{record.errorCode}</code></p>}
            <div className="bridge-history-payload">
              <h4>请求参数</h4>
              <pre className="bridge-test-result" tabIndex={0} aria-label="请求参数 JSON">{pretty(record.args)}</pre>
            </div>
            <details className="bridge-history-sources">
              <summary>参数与凭据来源</summary>
              <div>
                {[{ label: "参数", sources: record.argSources }, { label: "调用凭据", sources: record.credentialSources }].flatMap(group => Object.entries(group.sources ?? {}).map(([path, source]) => <p className="field-hint" key={`${group.label}:${path}`}>
                  {group.label} <code>{path || "（根节点）"}</code>：{source.source === "dictionary" ? <code>{`{{dictionary:${source.dictionaryId}:${source.key}}}`}</code> : source.reason === "legacy-unknown" ? "[来源未知，需重新选择或填写]" : "[按 Schema 策略未记录，需重新填写]"}
                </p>))}
                {record.credentialValues && Object.keys(record.credentialValues).length > 0 && <>
                  <h4>已记录的凭据值</h4>
                  <pre className="bridge-test-result" tabIndex={0} aria-label="已记录的凭据值 JSON">{pretty(record.credentialValues)}</pre>
                </>}
                {!Object.keys(record.argSources ?? {}).length && !Object.keys(record.credentialSources ?? {}).length && !Object.keys(record.credentialValues ?? {}).length && <p className="field-hint">暂无来源记录</p>}
              </div>
            </details>
          </div>
          <footer className="bridge-history-actions">
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => onReuse(record)}>载入参数并前往测试</Button>
            <p className="field-hint">载入后需手动执行，使用当前已保存的工具定义，字典引用将重新解析。</p>
            {record.definitionChanged && <p className="field-hint">工具定义已变化，再次执行使用当前定义及 Schema。</p>}
            {record.legacy && <p className="field-hint">旧历史缺少完整来源信息，无法自动还原的凭据需重新选择。</p>}
            {record.redacted && <p className="field-hint">部分手动值未记录，需在测试时补填。</p>}
          </footer>
        </>}
      </section>
    </div>}
  </section>;
}
