import { useState } from "react";
import { BRIDGE_HTTP_METHODS } from "../../web-bridge/http-methods";
import type { WebBridgeTool } from "../../web-bridge/catalog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { ErrorNotice } from "../components/common";

export function BridgeToolForm({ value, existing, disabled, onChange, onInvalidChange }: {
  value: string; existing: boolean; disabled: boolean; onChange: (value: string) => void; onInvalidChange: (invalid: boolean) => void;
}) {
  const definition = JSON.parse(value) as WebBridgeTool;
  const [parameters, setParameters] = useState(JSON.stringify(definition.parameters, null, 2));
  const [fields, setFields] = useState(JSON.stringify(definition.fields, null, 2));
  const [execution, setExecution] = useState(definition.execution ? JSON.stringify(definition.execution, null, 2) : "");
  const [error, setError] = useState("");
  const update = (patch: Partial<WebBridgeTool>) => onChange(JSON.stringify({ ...definition, ...patch }, null, 2));
  const jsonField = (key: "parameters" | "fields" | "execution", text: string) => {
    if (key === "parameters") setParameters(text); else if (key === "fields") setFields(text); else setExecution(text);
    try {
      const parsedParameters = JSON.parse(key === "parameters" ? text : parameters);
      const parsedFields = JSON.parse(key === "fields" ? text : fields);
      const executionText = key === "execution" ? text : execution;
      const parsedExecution = executionText.trim() ? JSON.parse(executionText) : undefined;
      if (!parsedParameters || typeof parsedParameters !== "object" || Array.isArray(parsedParameters)) throw new Error("参数 Schema 必须是 JSON 对象");
      if (!Array.isArray(parsedFields) || !parsedFields.every(item => typeof item === "string")) throw new Error("返回字段必须是 JSON 字符串数组");
      if (parsedExecution !== undefined && (!parsedExecution || typeof parsedExecution !== "object" || Array.isArray(parsedExecution))) throw new Error("HTTP 执行配置必须是 JSON 对象");
      setError(""); onInvalidChange(false);
      update({ parameters: parsedParameters, fields: parsedFields, execution: parsedExecution });
    } catch (error) { setError((error as Error).message); onInvalidChange(true); }
  };
  return <fieldset className="bridge-tool-form" disabled={disabled}>
    <label htmlFor="bridge-tool-id">工具 ID</label><Input id="bridge-tool-id" value={definition.toolId} disabled={existing} onChange={event => update({ toolId: event.target.value })} />
    <label htmlFor="bridge-tool-description">工具说明</label><Input id="bridge-tool-description" value={definition.description} onChange={event => update({ description: event.target.value })} />
    <label htmlFor="bridge-tool-method">请求方法</label><select id="bridge-tool-method" value={definition.method} onChange={event => update({ method: event.target.value as WebBridgeTool["method"] })}>{BRIDGE_HTTP_METHODS.map(method => <option key={method}>{method}</option>)}</select>
    <label htmlFor="bridge-tool-path">接口路径</label><Input id="bridge-tool-path" value={definition.path} onChange={event => update({ path: event.target.value })} />
    <label htmlFor="bridge-tool-risk">风险类型</label><select id="bridge-tool-risk" value={definition.risk} onChange={event => update({ risk: event.target.value as WebBridgeTool["risk"] })}>{[["read", "读取"], ["write", "写入"], ["delete", "删除"], ["execute", "执行"], ["download", "下载"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    <label htmlFor="bridge-tool-approval">执行确认</label><select id="bridge-tool-approval" value={definition.approval} onChange={event => update({ approval: event.target.value as WebBridgeTool["approval"] })}><option value="none">无需确认</option><option value="user">用户确认</option></select>
    <label htmlFor="bridge-tool-timeout">超时（毫秒）</label><Input id="bridge-tool-timeout" type="number" min={100} max={120000} value={definition.timeoutMs} onChange={event => update({ timeoutMs: Number(event.target.value) })} />
    <label htmlFor="bridge-tool-version">定义版本</label><Input id="bridge-tool-version" value={definition.catalogVersion} onChange={event => update({ catalogVersion: event.target.value })} />
    <p className="field-hint bridge-form-hint">工具在调用时选择应用下的运行环境，使用该环境的网站和浏览器资料。</p>
    {([
      ["parameters", "参数 Schema（JSON）", parameters],
      ["fields", "返回字段（JSON 数组）", fields],
      ["execution", "执行配置（JSON，可选）", execution],
    ] as const).map(([key, label, text]) => <details key={key} className="bridge-json-section">
      <summary>{label}</summary>
      <Textarea id={`bridge-tool-${key}`} aria-label={label} className="font-mono" rows={key === "fields" ? 3 : 6} spellCheck={false} value={text} onChange={event => jsonField(key, event.target.value)} />
      {key === "parameters" && <p className="field-hint">测试输入由此 JSON Schema 生成。根节点声明 type: object 和 properties；string 默认单行，多行需配置 {"\"x-ui\": { \"widget\": \"textarea\", \"rows\": 7 }"}。使用 title、description 和 required 配置标签、说明与必填项。</p>}
      {key === "execution" && <p className="field-hint">localHttp 不复用浏览器 Cookie；凭据只填写加密字典引用，勿填写真实 AK/SK。browser 使用运行环境绑定的已登录页签，需在插件授权站点。调用凭据可用 credentialInputs 声明；完整返回设置 response.mode 为 fullJson。两种模式均可配置 postprocess: {"{ runtime: \"nodejs\", code: \"return response;\", timeoutMs: 1000 }"}，使用 response 和 args 处理筛选后的结果。</p>}
    </details>)}
    <ErrorNotice message={error} />
  </fieldset>;
}
