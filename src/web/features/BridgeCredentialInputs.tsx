import { useState } from "react";
import { BookOpen, Unlink } from "lucide-react";
import type { BrowserExecution } from "../../web-bridge/browser-execution";
import type { CredentialBindings } from "../../web-bridge/credential-inputs";
import type { DictionaryDetail, DictionaryListView } from "./DictionariesPage";
import { useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";

function DictionaryKeys({ dictionaryId, selectedKey, onChange }: { dictionaryId: string; selectedKey: string; onChange: (key: string) => void }) {
  const { data, error, reload } = useResource<DictionaryDetail>(`/dictionaries/${encodeURIComponent(dictionaryId)}`);
  return <>
    <ErrorNotice message={error} />
    {error && <Button variant="outline" onClick={reload}>重试</Button>}
    {!data && !error && <Loading />}
    {data && <><label htmlFor="credential-dictionary-key">Key</label>
      <select id="credential-dictionary-key" value={selectedKey} onChange={event => onChange(event.target.value)}>
        <option value="">请选择 key</option>
        {data.enabled && data.readiness === "ready" && Object.keys(data.keys).map(key => <option key={key} value={key}>{key}</option>)}
      </select>
      {!Object.keys(data.keys).length && <p className="field-hint">此字典暂无可用的 key。</p>}
      {(!data.enabled || data.readiness !== "ready") && <p role="alert">字典已禁用或密钥不可用，请检查字典设置。</p>}
    </>}
  </>;
}

function CredentialDictionaryPicker({ name, disabled, onSelect, onClose }: {
  name: string; disabled: boolean; onSelect: (dictionaryId: string, key: string) => void; onClose: () => void;
}) {
  const [cursor, setCursor] = useState("");
  const [dictionaryId, setDictionaryId] = useState(""), [selectedKey, setSelectedKey] = useState("");
  const { data, error, reload } = useResource<{ items: DictionaryListView[]; nextCursor: string | null }>(
    `/dictionaries?${new URLSearchParams({ kind: "encrypted", ...(cursor ? { cursor } : {}) })}`,
  );
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="bridge-credential-dialog">
      <DialogHeader><DialogTitle>引入字典 · {name}</DialogTitle><DialogDescription>选择加密字典和 key，仅引用凭据，不读取或展示明文。</DialogDescription></DialogHeader>
      <ErrorNotice message={error} />
      {error && <Button variant="outline" onClick={reload}>重试</Button>}
      {!data && !error && <Loading />}
      {data && <>
        <label htmlFor="credential-dictionary">字典</label>
        <select id="credential-dictionary" disabled={disabled} value={dictionaryId} onChange={event => { setDictionaryId(event.target.value); setSelectedKey(""); }}>
          <option value="">请选择字典</option>
          {data.items.map(dictionary => <option key={dictionary.id} value={dictionary.id} disabled={!dictionary.enabled || dictionary.readiness !== "ready"}>
            {dictionary.name}{!dictionary.enabled ? "（已禁用）" : dictionary.readiness !== "ready" ? "（密钥不可用）" : ""}
          </option>)}
        </select>
        {!data.items.length && <p className="field-hint">暂无加密字典，请先在字典页面创建。</p>}
        <div className="actions">
          {cursor && <Button variant="outline" size="sm" onClick={() => { setCursor(""); setDictionaryId(""); setSelectedKey(""); }}>返回第一页</Button>}
          {data.nextCursor && <Button variant="outline" size="sm" onClick={() => { setCursor(data.nextCursor!); setDictionaryId(""); setSelectedKey(""); }}>下一页</Button>}
        </div>
      </>}
      {dictionaryId && <DictionaryKeys key={dictionaryId} dictionaryId={dictionaryId} selectedKey={selectedKey} onChange={setSelectedKey} />}
      <DialogFooter><Button variant="outline" onClick={onClose}>取消</Button>
        <Button disabled={disabled || !dictionaryId || !selectedKey} onClick={() => onSelect(dictionaryId, selectedKey)}>引入</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function BridgeCredentialInputs({ execution, value, disabled, onChange }: {
  execution: BrowserExecution; value: CredentialBindings; disabled: boolean; onChange: (value: CredentialBindings) => void;
}) {
  const [pickerName, setPickerName] = useState<string | null>(null);
  const defaults = execution.preprocess.credentials ?? {};
  const names = [...new Set([...(execution.credentialInputs ?? []), ...Object.keys(defaults)])];
  if (!names.length) return null;
  return <fieldset disabled={disabled} className="bridge-credential-inputs"><legend>本次调用凭据</legend>
    <p className="field-hint">选择加密字典或手动输入。手动值仅本次使用，不保存到工具、参数或 Agent 对话，执行后清空。</p>
    {names.map(name => {
      const binding = Object.hasOwn(value, name) ? value[name] : undefined;
      const reference = binding?.source === "dictionary" ? binding : !binding && Object.hasOwn(defaults, name) ? defaults[name] : undefined;
      const inputId = `bridge-credential-${name}-value`;
      return <div className="bridge-credential-row" key={name}>
        <label htmlFor={inputId}>{name}:</label>
        <div className={`bridge-credential-control${reference ? " is-reference" : ""}`}>
        <Input id={inputId} className={reference ? "bridge-credential-reference" : undefined} readOnly={!!reference}
          type={reference ? "text" : "password"} autoComplete="off" maxLength={8192}
          value={reference ? `{{dictionary:${reference.dictionaryId}:${reference.key}}}` : binding?.source === "inline" ? binding.value : ""}
          title={reference ? `字典 ${reference.dictionaryId} · ${reference.key}` : undefined}
          onChange={event => onChange({ ...value, [name]: { source: "inline", value: event.target.value } })} />
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled}
          aria-label={`${reference ? "清空字典" : "引入字典"} ${name}`} title={reference ? "清空字典" : "引入字典"}
          onClick={() => reference ? onChange({ ...value, [name]: { source: "inline", value: "" } }) : setPickerName(name)}>
          {reference ? <Unlink size={15} /> : <BookOpen size={15} />}
        </Button>
        </div>
      </div>;
    })}
    {pickerName !== null && <CredentialDictionaryPicker name={pickerName} disabled={disabled} onClose={() => setPickerName(null)}
      onSelect={(dictionaryId, key) => { onChange({ ...value, [pickerName]: { source: "dictionary", dictionaryId, key } }); setPickerName(null); }} />}
  </fieldset>;
}
