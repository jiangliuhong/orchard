import { useEffect, useState } from "react";
import type { StorageUsage, StorageScan, UsageSize } from "../../storage/usage.js";
import { api, send } from "../lib/api";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/common";

type View = { status: string; scanId: string | null; result: StorageUsage | null; error?: string };
export function formatStorageBytes(value: string | null | undefined) {
  if (value == null) return "不可用";
  let bytes = BigInt(value), divisor = 1n, unit = "B";
  for (const next of ["KiB", "MiB", "GiB", "TiB", "PiB"]) { if (bytes / divisor < 1024n) break; divisor *= 1024n; unit = next; }
  return `${bytes / divisor}${divisor > 1n ? `.${(bytes % divisor * 10n) / divisor}` : ""} ${unit}`;
}
function SizeCells({ value }: { value: UsageSize }) { const unknown = value.incomplete ? " + 未知" : ""; return <><td>{formatStorageBytes(value.allocatedBytes)}{unknown}</td><td>{formatStorageBytes(value.logicalBytes)}{unknown}</td><td>{value.fileCount}{unknown}</td></>; }
export function StorageSettings() {
  const [view, setView] = useState<View>({ status: "idle", scanId: null, result: null }), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0), [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async (id: string) => {
      try { const scan = await api<StorageScan>(`/storage/usage/scans/${id}`); if (cancelled) return; setView(previous => ({ status: scan.status, scanId: scan.scanId, result: scan.result ?? previous.result, error: scan.error })); if (scan.status === "scanning") timer = setTimeout(() => void poll(id), 800); }
      catch (error) { if (!cancelled) { setError((error as Error).message); setView(previous => ({ ...previous, status: "failed" })); } }
    };
    const load = async () => {
      setError("");
      try {
        const current = await api<View>("/storage/usage"); if (cancelled) return; setView(current);
        if (refresh || !current.result && current.status === "idle") {
          const next = await send<{ scanId: string }>("/storage/usage/scan"); if (cancelled) return;
          setView(previous => ({ ...previous, status: "scanning", scanId: next.scanId })); await poll(next.scanId);
        } else if (current.status === "scanning" && current.scanId) await poll(current.scanId);
      } catch (error) { if (!cancelled) setError((error as Error).message); }
    };
    void load(); return () => { cancelled = true; clearTimeout(timer); };
  }, [refresh]);
  const result = view.result;
  return <div className="detail-stack storage-settings">
    <div className="settings-section-heading"><strong>存储空间</strong><Button variant="outline" size="sm" disabled={view.status === "scanning"} onClick={() => setRefresh(value => value + 1)}>刷新统计</Button></div>
    <ErrorNotice message={error || view.error || ""} />
    <p role="status" className="field-hint">{view.status === "scanning" ? "统计中，保留上次结果…" : view.status === "failed" ? "统计失败，旧值已过期" : view.status === "partial" ? "部分结果：有不可统计或排除项，不代表零占用" : result ? `统计于 ${new Date(result.completedAt).toLocaleString()}` : "尚无统计结果"}</p>
    {result && <>
      <div className="storage-path"><code>{result.dataDir}</code><Button size="sm" variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(result.dataDir); setCopied(true); } catch { setError("无法复制，请手动选择路径"); } }}>{copied ? "已复制" : "复制路径"}</Button></div>
      <p>Orchard 占用：<strong>{formatStorageBytes(result.allocatedBytes ?? result.logicalBytes)}</strong>{result.incomplete && " + 未知（仅已统计部分）"}{result.allocatedBytes === null ? "（分配空间不可用，降级显示逻辑大小）" : "（实际分配空间估算）"} · {result.fileCount} 个普通文件</p>
      <p className="field-hint">所在卷总容量 {formatStorageBytes(result.filesystem?.totalBytes)} · 运行账户可用 {formatStorageBytes(result.filesystem?.availableBytes)}。这是整个磁盘/卷，不是 Orchard 配额。{result.filesystem && `容量采样于 ${new Date(result.filesystem.sampledAt).toLocaleTimeString()}`}</p>
      <div className="storage-table-scroll"><table className="storage-table"><caption>数据目录分类（互斥统计）</caption><thead><tr><th>分类</th><th>分配空间</th><th>逻辑大小</th><th>文件数</th></tr></thead><tbody>{result.categories.map(value => <tr key={value.id}><th scope="row">{value.name}</th><SizeCells value={value} /></tr>)}</tbody><tfoot><tr><th>合计</th><SizeCells value={result} /></tr></tfoot></table></div>
      <div className="storage-table-scroll"><table className="storage-table"><caption>项目占用明细（分类下钻，不重复相加）</caption><thead><tr><th>项目</th><th>缓存</th><th>快照/临时</th><th>活动资源</th></tr></thead><tbody>{result.projects.map(value => <tr key={value.id}><th scope="row">{value.name}<small>{value.id}</small></th><td>{formatStorageBytes(value.cacheBytes)}{value.incomplete && " + 未知"}</td><td>{formatStorageBytes(value.temporaryBytes)}{value.incomplete && " + 未知"}</td><td>{value.activeLease ? "有" : "无"}</td></tr>)}{!result.projects.length && <tr><td colSpan={4}>暂无项目缓存</td></tr>}</tbody></table></div>
      {Object.keys(result.reasons).length > 0 && <p className="field-hint">部分/排除原因：{Object.entries(result.reasons).map(([key, count]) => `${key}: ${count}`).join("；")}。排除挂载目录 {result.excluded} 项。</p>}
    </>}
    <p className="field-hint">本页仅查看，不会清理文件。统计覆盖整个实际数据目录（含隐藏文件），不包含目录外 SSH 私钥、Provider 用户目录和外部备份；不跟随符号链接、不跨设备，硬链接仅计一次。运行中变化、压缩、reflink 和共享块会影响估算，不等于删除后的可释放空间，也不是一致性实时快照。</p>
  </div>;
}
