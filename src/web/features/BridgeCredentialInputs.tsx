import { useEffect, useState } from "react";
import { credentialProperties, credentialRequired, credentialSchema } from "../../web-bridge/credential-schema";
import { captureHistory, pointerPart } from "../../web-bridge/history-policy";
import { BookOpen, Unlink } from "lucide-react";
import type { BrowserExecution } from "../../web-bridge/browser-execution";
import type { CredentialBindings } from "../../web-bridge/credential-inputs";
import type { DictionaryDetail, DictionaryListView } from "./DictionariesPage";
import { api, useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";

function DictionaryKeys({ dictionaryId, disabled, onSelect }: { dictionaryId: string; disabled: boolean; onSelect: (key: string) => void }) {
  const [search, setSearch] = useState("");
  const { data, error, reload } = useResource<DictionaryDetail>(`/dictionaries/${encodeURIComponent(dictionaryId)}`);
  const keys = Object.entries(data?.keys ?? {}).filter(([key]) => key.toLowerCase().includes(search.trim().toLowerCase()));
  return <section className="bridge-dictionary-column" aria-label="Key 列表">
    <label htmlFor="credential-key-search">Key</label>
    <Input id="credential-key-search" placeholder="搜索 Key…" value={search} onChange={event => setSearch(event.target.value)} />
    <div className="bridge-dictionary-list">
      <ErrorNotice message={error} />
      {error && <Button variant="outline" onClick={reload}>重试</Button>}
      {!data && !error && <Loading />}
      {data && (!data.enabled || data.readiness !== "ready") ? <p role="alert">字典已禁用或不可用，请检查字典设置。</p> : data && <>
        {keys.map(([key, entry]) => <button type="button" className="bridge-dictionary-item" key={key}
          disabled={disabled || entry.type !== "string"} onClick={() => onSelect(key)}>
          <span>{key}</span>{entry.type !== "string" && <small>仅支持字符串</small>}
        </button>)}
        {!keys.length && <p className="field-hint" role="status">{search.trim() ? "没有匹配的 Key。" : "此字典暂无 Key。"}</p>}
      </>}
    </div>
  </section>;
}

function CredentialDictionaryPicker({ name, disabled, initialDictionaryId, onSelect, onClose }: {
  name: string; disabled: boolean; initialDictionaryId: string; onSelect: (dictionaryId: string, key: string) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState(""), [dictionaryId, setDictionaryId] = useState(initialDictionaryId);
  const [items, setItems] = useState<DictionaryListView[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      const all: DictionaryListView[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: DictionaryListView[]; nextCursor: string | null } = await api(
          `/dictionaries?${new URLSearchParams({ ...(cursor ? { cursor } : {}) })}`, { signal: controller.signal },
        );
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) setItems(all);
    })().catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const dictionaries = items.filter(item => item.name.toLowerCase().includes(search.trim().toLowerCase()));
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="bridge-credential-dialog">
      <DialogHeader><DialogTitle>引入字典 · {name}</DialogTitle><DialogDescription>选择字典，点击字符串 Key 即可引用。这里只展示名称，不展示值。</DialogDescription></DialogHeader>
      <div className="bridge-dictionary-columns">
        <section className="bridge-dictionary-column" aria-label="字典列表">
          <label htmlFor="credential-dictionary-search">字典</label>
          <Input id="credential-dictionary-search" autoFocus placeholder="搜索字典…" value={search} onChange={event => setSearch(event.target.value)} />
          <div className="bridge-dictionary-list">
            <ErrorNotice message={error} />
            {error && <Button variant="outline" onClick={() => setRevision(value => value + 1)}>重试</Button>}
            {loading && <Loading />}
            {!loading && !error && dictionaries.map(dictionary => <button type="button" key={dictionary.id}
              className="bridge-dictionary-item" aria-pressed={dictionaryId === dictionary.id}
              disabled={disabled || !dictionary.enabled || dictionary.readiness !== "ready"} onClick={() => setDictionaryId(dictionary.id)}>
              <span>{dictionary.name}</span>
              {(!dictionary.enabled || dictionary.readiness !== "ready") && <small>{!dictionary.enabled ? "已禁用" : "不可用"}</small>}
            </button>)}
            {!loading && !error && !dictionaries.length && <p className="field-hint" role="status">{search.trim() ? "没有匹配的字典。" : "暂无字典，请先在字典页面创建。"}</p>}
          </div>
        </section>
        {dictionaryId ? <DictionaryKeys key={dictionaryId} dictionaryId={dictionaryId} disabled={disabled} onSelect={key => onSelect(dictionaryId, key)} />
          : <section className="bridge-dictionary-column" aria-label="Key 列表"><label htmlFor="credential-key-search">Key</label><Input id="credential-key-search" placeholder="搜索 Key…" disabled /><p className="field-hint">请先选择左侧字典。</p></section>}
      </div>
    </DialogContent>
  </Dialog>;
}

export function BridgeCredentialInputs({ execution, value, disabled, onChange }: {
  execution: BrowserExecution; value: CredentialBindings; disabled: boolean; onChange: (value: CredentialBindings) => void;
}) {
  const [pickerName, setPickerName] = useState<string | null>(null);
  const [lastDictionaryId, setLastDictionaryId] = useState("");
  const defaults = execution.preprocess.credentials ?? {};
  const properties = credentialProperties(execution);
  const names = Object.keys(properties);
  const required = credentialRequired(execution);
  if (!names.length) return null;
  return <fieldset disabled={disabled} className="bridge-credential-inputs"><legend>本次调用凭据</legend>
    <p className="field-hint">字典引用会保留在历史中，执行时重新解析；手动值是否记录由 credentialSchema 的 x-history.record 决定。未记录的值还原时需要重新填写。</p>
    {names.map(name => {
      const binding = Object.hasOwn(value, name) ? value[name] : undefined;
      const reference = binding?.source === "dictionary" ? binding : !binding && Object.hasOwn(defaults, name) ? defaults[name] : undefined;
      const inputId = `bridge-credential-${name}-value`;
      const policySources = captureHistory({ [name]: "" }, credentialSchema(execution)).sources;
      const recordsManualValue = !policySources[`/${pointerPart(name)}`] && !policySources[""];
      return <div className="bridge-credential-row" key={name}>
        <label htmlFor={inputId}>{typeof properties[name].title === "string" ? properties[name].title : name}:</label>
        <div className={`bridge-credential-control${reference ? " is-reference" : ""}`}>
        <Input id={inputId} className={reference ? "bridge-credential-reference" : undefined} readOnly={!!reference}
          type={reference ? "text" : "password"} autoComplete="off" maxLength={typeof properties[name].maxLength === "number" ? Math.min(8192, properties[name].maxLength) : 8192}
          aria-required={required.includes(name)} placeholder={required.includes(name) ? "请选择字典或填写凭据（必填）" : "可选凭据"}
          value={reference ? `{{dictionary:${reference.dictionaryId}:${reference.key}}}` : binding?.source === "inline" ? binding.value : ""}
          title={reference ? `字典 ${reference.dictionaryId} · ${reference.key}（点击重新选择）` : undefined}
          onClick={() => { if (reference && !disabled) setPickerName(name); }}
          onKeyDown={event => { if (reference && !disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPickerName(name); } }}
          onChange={event => onChange({ ...value, [name]: { source: "inline", value: event.target.value } })} />
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled}
          aria-label={`${reference ? "清空字典" : "引入字典"} ${name}`} title={reference ? "清空字典" : "引入字典"}
          onClick={() => reference ? onChange({ ...value, [name]: { source: "inline", value: "" } }) : setPickerName(name)}>
          {reference ? <Unlink size={15} /> : <BookOpen size={15} />}
        </Button>
        </div>
        <p className="field-hint bridge-credential-history-policy">{typeof properties[name].description === "string" ? `${properties[name].description} · ` : ""}{recordsManualValue ? "Schema 允许将手动值保存在执行历史中" : "Schema 禁止记录手动值，历史只保留占位"}</p>
      </div>;
    })}
    {pickerName !== null && <CredentialDictionaryPicker name={pickerName} disabled={disabled}
      initialDictionaryId={(value[pickerName]?.source === "dictionary" ? value[pickerName].dictionaryId : !value[pickerName] ? defaults[pickerName]?.dictionaryId : undefined) ?? lastDictionaryId}
      onClose={() => setPickerName(null)}
      onSelect={(dictionaryId, key) => { setLastDictionaryId(dictionaryId); onChange({ ...value, [pickerName]: { source: "dictionary", dictionaryId, key } }); setPickerName(null); }} />}
  </fieldset>;
}
