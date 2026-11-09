import { useEffect, useRef, useState } from "react";
import { ToastNotice } from "../components/ToastNotice";
import { AlertTriangle, Download, KeyRound, LockKeyhole, PlusCircle, ShieldCheck, Upload } from "lucide-react";
import { send, useCommandKey, useResource } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { ErrorNotice } from "../components/common";
import { parseStrictJson } from "../../dictionaries/canonical.js";

interface SecretsStatus {
  configured: boolean; generation: number; activeKeyId: string | null; readOnly: boolean;
  keys: { keyId: string; createdAt: number; active: boolean }[];
  encryptedDictionaries: number; missingKeyIds: string[];
}
interface VerificationView {
  generation: number; verified: boolean; message: string;
  dictionaries: { dictionaryId: string; entries: number; verified: number; missingKeyIds: string[]; failedKeys: string[] }[];
}

export function SecretKeySettings() {
  const { data: status, error, reload } = useResource<SecretsStatus>("/secrets/status");
  const [busy, setBusy] = useState(""), [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const [makeActive, setMakeActive] = useState(false);
  const [importText, setImportText] = useState(""), [importOpen, setImportOpen] = useState(false), [importActiveKeyId, setImportActiveKeyId] = useState("");
  const [verification, setVerification] = useState<VerificationView | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: "export" | "activate"; keyId?: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const commandKey = useCommandKey();
  const clearImport = () => { setImportText(""); setImportOpen(false); setImportActiveKeyId(""); commandKey({ cleared: true }); if (file.current) file.current.value = ""; };
  useEffect(() => { setVerification(null); }, [status?.generation]);
  const action = async (name: string, work: () => Promise<void>) => {
    setBusy(name); setActionError(""); setNotice(""); setVerification(null);
    try { await work(); reload(); }
    catch (error) { setActionError((error as Error).message); }
    finally { setBusy(""); }
  };
  const generate = () => action("generate", async () => {
    if (!status) return;
    const input = { expectedGeneration: status.generation, makeActive };
    const result = await send<{ keyId: string }>("/secrets/keys", { ...input, requestId: commandKey({ action: "generate", ...input }) });
    setNotice(`已生成密钥 ${result.keyId.slice(0, 8)}…，请立即下载备份并妥善保管。`);
    setMakeActive(false);
  });
  const activate = (keyId: string) => action("activate", async () => {
    if (!status) return;
    const input = { expectedGeneration: status.generation, keyId };
    await send("/secrets/active-key", { ...input, requestId: commandKey({ action: "activate", ...input }) }, "PUT");
    setConfirmation(null);
    setNotice("已切换活动密钥，只影响后续新增或替换的加密值。历史密钥继续保留。");
  });
  const importBackup = () => action("import", async () => {
    if (!status || !importText.trim()) throw new Error("请上传或粘贴完整备份文本");
    if (!status.configured && !importActiveKeyId) throw new Error("请明确选择活动密钥");
    const input = { expectedGeneration: status.generation, backupText: importText, ...(importActiveKeyId ? { activeKeyId: importActiveKeyId } : {}) };
    const result = await send<{ added: number; unchanged: number }>("/secrets/import", { ...input, requestId: commandKey({ action: "import", ...input }) });
    clearImport();
    setNotice(`导入完成：新增 ${result.added} 把，无变化 ${result.unchanged} 把。`);
  });
  const exportBackup = () => action("export", async () => {
    if (!status) return;
    const backup = await send<{ formatVersion: number; keys: { keyId: string }[] }>("/secrets/export", { expectedGeneration: status.generation });
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
    const anchor = document.createElement("a");
    try {
      anchor.href = url; anchor.download = `orchard-dictionary-keys-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor); anchor.click();
    } finally { anchor.remove(); URL.revokeObjectURL(url); }
    setConfirmation(null);
    setNotice(`已下载包含 ${backup.keys.length} 把密钥的备份。请与 Git 仓库分开保管。`);
  });
  const verify = () => action("verify", async () => {
    if (status) setVerification(await send<VerificationView>("/secrets/verify", { expectedGeneration: status.generation }));
  });
  const readFile = async (selected?: File) => {
    setActionError(""); setImportText(""); setImportActiveKeyId("");
    if (!selected) return;
    if (selected.size > 1024 * 1024) { setActionError("备份文件最多 1 MiB"); return; }
    try { setImportText(await selected.text()); } catch { setActionError("无法读取备份文件"); }
  };
  if (error) return <ErrorNotice message={error} />;
  if (!status) return <p className="field-hint">正在加载密钥状态…</p>;
  return <section className="secret-key-settings" aria-label="加密字典密钥" aria-busy={!!busy}>
    <header className="secret-key-heading">
      <div><h2><KeyRound size={18} />加密字典密钥</h2><p>管理本机密钥环，用于加密字典值及解密历史修订。</p></div>
      <span className="secret-key-generation">代次 {status.generation}{status.readOnly ? " · 存储只读" : ""}</span>
    </header>
    <ErrorNotice message={actionError} />
    <ToastNotice message={notice} onDismiss={() => setNotice("")} />
    <div className="secret-key-overview" aria-label="密钥环状态">
      <div><span>活动密钥</span><strong><code>{status.activeKeyId ? `${status.activeKeyId.slice(0, 8)}…` : "未设置"}</code></strong></div>
      <div><span>密钥总数</span><strong>{status.keys.length}<small>把</small></strong></div>
      <div><span>加密字典</span><strong>{status.encryptedDictionaries}<small>个</small></strong></div>
    </div>
    {status.readOnly && <div className="secret-key-warning" role="status"><LockKeyhole size={16} /><p>密钥存储当前为只读，无法生成、导入或切换密钥。仍可下载备份与验证解密。</p></div>}
    {!status.configured ? <div className="secret-key-empty"><KeyRound size={24} /><strong>尚未配置密钥环</strong><p>生成随机密钥，或从其他设备导入备份文件。</p></div> : <>
      {status.missingKeyIds.length > 0 && <div className="secret-key-warning" role="alert"><AlertTriangle size={16} /><p>缺少 keyId：{status.missingKeyIds.join("、")}</p></div>}
      <section className="secret-key-list" aria-label="密钥列表">
      <div className="secret-key-list-heading"><h3>密钥列表</h3><span>历史密钥保留用于解密旧数据</span></div>
      <div className="secret-key-table-scroll"><table className="secret-key-table"><thead><tr><th>密钥标识</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
        {status.keys.map(key => <tr key={key.keyId}><td><div className="secret-key-identity"><code>{key.keyId}</code>{key.active && <span className="secret-key-active">活动</span>}</div></td>
          <td>{new Date(key.createdAt).toLocaleString("zh-CN")}</td><td><Button variant="outline" size="sm" disabled={!!busy || key.active || status.readOnly}
            aria-label={`设为活动密钥 ${key.keyId.slice(0, 8)}`} onClick={() => setConfirmation({ kind: "activate", keyId: key.keyId })}>设为活动</Button></td></tr>)}
      </tbody></table></div></section>
    </>}
    <section className="secret-key-actions" aria-label="密钥操作">
    <div className="secret-key-action-heading"><h3>密钥操作</h3><span>生成后请及时备份，备份应与 Git 仓库分开保管。</span></div>
    <div className="secret-key-buttons">
      <Button disabled={!!busy || status.readOnly} onClick={() => void generate()}><PlusCircle size={14} />生成密钥</Button>
      <Button variant="outline" disabled={!!busy || status.readOnly} onClick={() => importOpen ? clearImport() : setImportOpen(true)}><Upload size={14} />导入备份</Button>
      <Button variant="outline" disabled={!!busy || !status.configured} onClick={() => setConfirmation({ kind: "export" })}><Download size={14} />下载备份</Button>
      <Button variant="outline" disabled={!!busy || !status.configured} onClick={() => void verify()}><ShieldCheck size={14} />验证解密</Button>
    </div>
    {status.configured && <label className="secret-key-activate-option"><input type="checkbox" checked={makeActive} disabled={!!busy || status.readOnly} onChange={event => setMakeActive(event.target.checked)} /> 将新密钥设为活动，保留历史密钥</label>}
    </section>
    {importOpen && <div className="dictionary-form secret-key-import" aria-label="导入备份">
      <div className="secret-key-import-heading"><Upload size={16} /><h3>导入密钥备份</h3><span>JSON · 最大 1 MiB</span></div>
      <label htmlFor="secret-import-file">上传备份文件</label><Input ref={file} id="secret-import-file" type="file" accept=".json,application/json" disabled={!!busy} onChange={event => void readFile(event.target.files?.[0])} />
      <label htmlFor="secret-import">粘贴完整备份文本（JSON，最多 1 MiB）</label>
      <Textarea id="secret-import" rows={6} className="font-mono" value={importText} disabled={!!busy} onChange={event => { setImportText(event.target.value); setImportActiveKeyId(""); }} autoComplete="off" spellCheck={false} />
      <p>{status.configured ? "默认保留现有活动密钥。" : "空密钥环导入需要明确选择一个活动密钥；备份内的标记仅作为建议。"}</p>
      {backupKeyIds(importText).length > 0 && <Select value={importActiveKeyId} onValueChange={setImportActiveKeyId}>
        <SelectTrigger aria-label="活动密钥（可选）"><SelectValue placeholder="选择活动密钥" /></SelectTrigger>
        <SelectContent>{backupKeyIds(importText).map(keyId => <SelectItem value={keyId} key={keyId}>{keyId}</SelectItem>)}</SelectContent>
      </Select>}
      <div className="entry-actions"><Button size="sm" disabled={!!busy || !importText.trim() || status.readOnly || !status.configured && !importActiveKeyId} onClick={() => void importBackup()}>导入并合并</Button>
        <Button variant="ghost" size="sm" disabled={!!busy} onClick={clearImport}>取消并清空</Button></div>
    </div>}
    {verification && verification.generation === status.generation && <div className={`secret-key-verification ${verification.verified ? "is-verified" : ""}`} aria-label="验证结果" role="status"><p>{verification.message}</p><ul>
      {verification.dictionaries.map(entry => <li key={entry.dictionaryId}>字典 {entry.dictionaryId.slice(0, 8)}…：{entry.verified}/{entry.entries} 可解密
        {entry.missingKeyIds.length > 0 && ` · 缺少 ${entry.missingKeyIds.join("、")}`}{entry.failedKeys.length > 0 && ` · 认证失败键 ${entry.failedKeys.join("、")}`}</li>)}
    </ul><p>验证结果为本次检查记录，修改字典或密钥后请重新验证。</p></div>}
    <Dialog open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{confirmation?.kind === "export" ? "确认备份范围" : "切换活动密钥"}</DialogTitle>
        <DialogDescription>{confirmation?.kind === "export" ? `备份包含全部 ${status.keys.length} 把字典密钥，可解密历史修订。文件包含敏感材料，请与 Git 仓库分开保管。` : "仅影响后续新增或替换的值，现有密文与历史密钥继续保留。"}</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setConfirmation(null)}>取消</Button>
        <Button disabled={!!busy} onClick={() => confirmation?.kind === "export" ? void exportBackup() : void activate(confirmation!.keyId!)}>{confirmation?.kind === "export" ? "确认下载全部密钥" : "确认切换"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <footer className="secret-key-footnote"><LockKeyhole size={14} /><p>密钥丢失后无法解密已有值。页面不会回填、显示或持久化缓存密钥材料。</p></footer>
  </section>;
}

function backupKeyIds(text: string): string[] {
  try {
    const parsed = parseStrictJson(text) as { keys?: { keyId?: unknown }[] };
    if (!parsed || !Array.isArray(parsed.keys)) return [];
    return [...new Set(parsed.keys.map(key => key?.keyId).filter((key): key is string => typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)))];
  } catch { return []; }
}
