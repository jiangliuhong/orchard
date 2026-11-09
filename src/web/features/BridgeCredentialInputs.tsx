import type { BrowserExecution } from "../../web-bridge/browser-execution";
import type { CredentialBindings } from "../../web-bridge/credential-inputs";
import { Input } from "../components/ui/input";

/** No persistence: bindings are kept only in the active test panel. */
export function BridgeCredentialInputs({ execution, value, disabled, onChange }: {
  execution: BrowserExecution; value: CredentialBindings; disabled: boolean; onChange: (value: CredentialBindings) => void;
}) {
  const defaults = execution.preprocess.credentials ?? {};
  const names = [...new Set([...(execution.credentialInputs ?? []), ...Object.keys(defaults)])];
  if (!names.length) return null;
  return <fieldset disabled={disabled} className="bridge-tool-form"><legend>本次调用凭据</legend>
    <p className="field-hint">选择加密字典或手动输入。手动值仅本次使用，不保存到工具、参数或 Agent 对话，执行后清空。</p>
    {names.map(name => {
      const binding = Object.hasOwn(value, name) ? value[name] : undefined;
      const hasDefault = Object.hasOwn(defaults, name);
      const source = binding?.source ?? (hasDefault ? "default" : "dictionary");
      const update = (next: CredentialBindings[string]) => onChange({ ...value, [name]: next });
      return <div key={name}>
        <label htmlFor={`bridge-credential-${name}-source`}>{name} 来源</label>
        <select id={`bridge-credential-${name}-source`} value={source} onChange={event => {
          if (event.target.value === "default") { const next = { ...value }; delete next[name]; onChange(next); }
          else update(event.target.value === "inline" ? { source: "inline", value: "" } : { source: "dictionary", dictionaryId: "", key: "" });
        }}>
          {hasDefault && <option value="default">定义中的字典引用</option>}
          <option value="dictionary">指定加密字典</option><option value="inline">手动输入（仅本次）</option>
        </select>
        {source === "dictionary" && <>
          <label htmlFor={`bridge-credential-${name}-dictionary`}>{name} 字典 ID</label>
          <Input id={`bridge-credential-${name}-dictionary`} value={binding?.source === "dictionary" ? binding.dictionaryId : ""} onChange={event => update({ source: "dictionary", dictionaryId: event.target.value, key: binding?.source === "dictionary" ? binding.key : "" })} />
          <label htmlFor={`bridge-credential-${name}-key`}>{name} 字典键</label>
          <Input id={`bridge-credential-${name}-key`} value={binding?.source === "dictionary" ? binding.key : ""} onChange={event => update({ source: "dictionary", dictionaryId: binding?.source === "dictionary" ? binding.dictionaryId : "", key: event.target.value })} />
        </>}
        {source === "inline" && <><label htmlFor={`bridge-credential-${name}-value`}>{name} 手动值</label><Input id={`bridge-credential-${name}-value`} type="password" autoComplete="off" maxLength={8192} value={binding?.source === "inline" ? binding.value : ""} onChange={event => update({ source: "inline", value: event.target.value })} /></>}
      </div>;
    })}
  </fieldset>;
}
