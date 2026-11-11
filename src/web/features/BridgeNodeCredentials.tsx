import { useId, useState } from "react";
import { BookOpen, Unlink } from "lucide-react";
import type { WorkflowNode } from "../../domain/types.js";
import type { WebBridgeTool } from "../../web-bridge/catalog.js";
import { credentialProperties, credentialRequired } from "../../web-bridge/credential-schema.js";
import type { WorkflowCredentialBindings } from "../../web-bridge/credential-inputs.js";
import { useResource } from "../lib/api";
import { ErrorNotice, Loading } from "../components/common";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { CredentialDictionaryPicker } from "./BridgeCredentialInputs";

export function BridgeNodeCredentials({ node, disabled, onChange }: {
  node: WorkflowNode; disabled: boolean; onChange: (value: WorkflowCredentialBindings | undefined) => void;
}) {
  const tools = useResource<{ items: WebBridgeTool[] }>(`/web-bridge/tools?application=${encodeURIComponent(node.config.application ?? "")}`);
  const prefix = useId();
  const [picker, setPicker] = useState<string | null>(null);
  const tool = tools.data?.items.find(tool => tool.toolId === node.config.tool);
  const execution = tool?.execution?.transport === "browser" ? tool.execution : undefined;
  const bindings = node.config.credentialBindings ?? {};
  const properties = execution ? credentialProperties(execution) : {};
  const required = execution ? credentialRequired(execution) : [];
  const names = [...new Set([...Object.keys(properties), ...Object.keys(bindings)])];
  return <div className="detail-stack"><ErrorNotice message={tools.error} />
    {!tools.data && !tools.error && <Loading />}
    {tools.data && !tool && <p role="alert">引用的浏览器工具不存在，请检查应用与工具配置。</p>}
    {!!names.length && <fieldset disabled={disabled} className="bridge-credential-inputs"><legend>节点调用凭据</legend>
      <p className="field-hint">选择普通或加密字典的字符串键。显式引用在运行入队时固定版本；未配置的项使用工具默认凭据。</p>
      {names.map(name => {
        const reference = bindings[name] ?? execution?.preprocess.credentials?.[name];
        return <div className="bridge-credential-row" key={name}>
          <label htmlFor={`${prefix}-${name}`}>{typeof properties[name]?.title === "string" ? properties[name].title : name}{required.includes(name) ? "（必填）" : ""}</label>
          <div className="bridge-credential-control">
            <Input id={`${prefix}-${name}`} title={reference ? `字典 ${reference.dictionaryId} · ${reference.key}` : undefined} className="bridge-credential-reference" readOnly disabled={disabled} aria-label={`节点凭据 ${name}`}
              value={reference ? `{{dictionary:${reference.dictionaryId}:${reference.key}}}` : ""} placeholder="选择字典"
              onClick={() => { if (!disabled) setPicker(name); }} onKeyDown={event => {
                if (!disabled && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setPicker(name); }
              }} />
            <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`选择节点凭据 ${name}`} onClick={() => setPicker(name)}><BookOpen size={14} /></Button>
            {bindings[name] && <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`恢复默认凭据 ${name}`} onClick={() => {
              const next = { ...bindings }; delete next[name]; onChange(Object.keys(next).length ? next : undefined);
            }}><Unlink size={14} /></Button>}
          </div>
          {!Object.hasOwn(properties, name) && <p role="alert">工具已不再声明此凭据，请移除引用。</p>}
          {required.includes(name) && !reference && <p role="status">请选择凭据字典后运行。</p>}
        </div>;
      })}
    </fieldset>}
    {picker !== null && <CredentialDictionaryPicker name={picker} disabled={disabled}
      initialDictionaryId={bindings[picker]?.dictionaryId ?? execution?.preprocess.credentials?.[picker]?.dictionaryId ?? ""}
      onClose={() => setPicker(null)} onSelect={(dictionaryId, key) => {
        onChange({ ...bindings, [picker]: { source: "dictionary", dictionaryId, key } }); setPicker(null);
      }} />}
  </div>;
}
