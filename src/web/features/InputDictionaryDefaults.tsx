import { useState } from "react";
import { BookOpen, Unlink } from "lucide-react";
import { dictionaryDefaultKeyword, inputDictionaryDefaults, type DictionaryDefault } from "../../domain/input-defaults";
import type { JsonSchema } from "../../domain/types";
import { Button } from "../components/ui/button";
import { CredentialDictionaryPicker } from "./BridgeCredentialInputs";

export function InputDictionaryDefaults({ schema, disabled, onChange }: {
  schema: JsonSchema; disabled?: boolean; onChange: (schema: JsonSchema) => void;
}) {
  const [picker, setPicker] = useState<string>();
  const defaults = new Map(inputDictionaryDefaults(schema));
  const properties = schema && typeof schema === "object" && schema.type === "object"
    && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, JsonSchema> : {};
  const names = Object.keys(properties).filter(name => properties[name] !== false);
  const update = (name: string, ref?: DictionaryDefault) => {
    if (typeof schema !== "object" || !Object.hasOwn(properties, name)) return;
    const field = properties[name];
    const next = typeof field === "object" ? { ...field } : {};
    if (ref) next[dictionaryDefaultKeyword] = ref;
    else delete next[dictionaryDefaultKeyword];
    onChange({ ...schema, properties: { ...properties, [name]: next } });
  };
  const field = picker === undefined ? undefined : properties[picker];
  const type = field && typeof field === "object" ? field.type : undefined;
  const acceptedTypes = typeof type !== "string" ? ["string", "number", "boolean", "json"] :
    type === "integer" || type === "number" ? ["number", "json"] :
      type === "string" || type === "boolean" ? [type, "json"] : ["json"];
  return <details className="input-dictionary-defaults"><summary>字典默认值{defaults.size ? `（${defaults.size}）` : ""}</summary>
    <p className="field-hint">{names.length ? "调用缺少该参数时，读取普通字典的当前值。" : "请先在输入 Schema 中声明顶层参数。"}</p>
    {names.map(name => {
      const ref = defaults.get(name);
      return <div className="bridge-parameter-row" key={name}>
        <span className="break-all">{name}</span>
        <div className="script-parameter-inline">
          <Button type="button" variant="outline" size="sm" className="min-w-0" aria-label={`为 ${name} 选择字典默认值`} disabled={disabled} onClick={() => setPicker(name)}><BookOpen size={15} /><span className="truncate" title={ref?.key}>{ref ? ref.key : "选择字典"}</span></Button>
          {ref && <Button type="button" variant="ghost" size="icon-sm" aria-label={`清除 ${name} 的字典默认值`} disabled={disabled} onClick={() => update(name)}><Unlink size={15} /></Button>}
        </div>
      </div>;
    })}
    {picker !== undefined && Object.hasOwn(properties, picker) && <CredentialDictionaryPicker name={picker} disabled={!!disabled}
      initialDictionaryId={defaults.get(picker)?.dictionaryId ?? ""} acceptedTypes={acceptedTypes} plainOnly
      onClose={() => setPicker(undefined)} onSelect={(dictionaryId, key) => { update(picker, { dictionaryId, key }); setPicker(undefined); }} />}
  </details>;
}
