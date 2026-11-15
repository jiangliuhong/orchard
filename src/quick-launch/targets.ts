import { check } from "../domain/errors.js";
import type { JsonSchema } from "../domain/types.js";
import { assertSchema } from "../domain/validation.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import type { WebBridgeGateway } from "../web-bridge/gateway.js";
import { WORKFLOW_CREDENTIAL_BINDINGS_SCHEMA, type WorkflowCredentialBindings } from "../web-bridge/credential-inputs.js";
import { bridgeToolHash } from "../web-bridge/history.js";
import { captureHistory, pointerPart } from "../web-bridge/history-policy.js";

export type Target =
  | { kind: "workflow"; workflowId: string; versionId: string }
  | { kind: "script"; scriptId: string; versionId: string }
  | { kind: "browser_tool"; applicationId: string; toolId: string; environmentId: string | null; contractDigest: string; environmentDigest: string | null; timeoutMs: number; credentialBindings?: WorkflowCredentialBindings };
export type InputSource = { source: "dictionary"; dictionaryId: string; key: string };
export type InputSources = Record<string, InputSource>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = { type: "string", minLength: 1, maxLength: 200 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const shape = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export class QuickLaunchTargets {
  constructor(private readonly store: Store, private readonly bridge: WebBridgeGateway) {}

  list() {
    const workflows = this.store.all<{ id: string; name: string; workflowId: string; number: number }>(
      "SELECT v.id,w.name,w.id AS workflowId,v.version_no AS number FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id");
    const scripts = this.store.all<{ id: string; name: string; scriptId: string; number: number }>(
      "SELECT v.id,s.name,s.id AS scriptId,v.version_no AS number FROM script_versions v JOIN scripts s ON s.id=v.script_id WHERE v.status='published' AND s.status<>'archived'");
    return [
      ...workflows.map(row => ({ label: `${row.name} · v${row.number}`, target: { kind: "workflow", workflowId: row.workflowId, versionId: row.id } as const })),
      ...scripts.map(row => ({ label: `${row.name} · v${row.number}`, target: { kind: "script", scriptId: row.scriptId, versionId: row.id } as const })),
      ...this.bridge.tools().filter(tool => tool.enabled).flatMap(tool => {
        const environments = tool.execution ? this.bridge.config?.environments(tool.application).filter(env => env.enabled) ?? [] : [null];
        return environments.map(env => ({
          label: [tool.application, tool.toolId, env?.key ?? env?.id].filter(Boolean).join(" · "),
          target: { kind: "browser_tool", applicationId: tool.application, toolId: tool.toolId, environmentId: env?.id ?? null,
            contractDigest: bridgeToolHash(tool), environmentDigest: env ? digest(canonicalJson(env)) : null, timeoutMs: tool.timeoutMs } as const
        }));
      })
    ].flatMap(option => {
      try {
        const contract = this.contract(option.target);
        return [{ ...option, schema: contract.schema, confirmation: contract.confirmation }];
      } catch { return []; }
    });
  }

  contract(value: unknown): { target: Target; schema: JsonSchema; confirmation: boolean } {
    assertSchema(value, { oneOf: [
      shape({ kind: { const: "workflow" }, workflowId: id, versionId: id }),
      shape({ kind: { const: "script" }, scriptId: id, versionId: id }),
      { ...shape({ kind: { const: "browser_tool" }, applicationId: id, toolId: id, environmentId: { anyOf: [id, { type: "null" }] },
        contractDigest: hash, environmentDigest: { anyOf: [hash, { type: "null" }] }, timeoutMs: { type: "integer", minimum: 1 } }),
        properties: { kind: { const: "browser_tool" }, applicationId: id, toolId: id, environmentId: { anyOf: [id, { type: "null" }] },
          contractDigest: hash, environmentDigest: { anyOf: [hash, { type: "null" }] }, timeoutMs: { type: "integer", minimum: 1 },
          credentialBindings: WORKFLOW_CREDENTIAL_BINDINGS_SCHEMA } }
    ] }, "执行目标");
    const target = value as Target;
    if (target.kind === "workflow") {
      const version = this.store.version(target.versionId);
      check(version.workflowId === target.workflowId, "TARGET_CHANGED", "工作流版本不匹配");
      return { target, schema: version.definition.inputSchema, confirmation: false };
    }
    if (target.kind === "script") {
      const script = this.store.script(target.scriptId), version = this.store.scriptVersion(target.versionId);
      check(script.status !== "archived" && version.status === "published" && version.scriptId === target.scriptId,
        "TARGET_CHANGED", "脚本已归档或版本不匹配");
      return { target, schema: this.store.scriptDefinition(target.scriptId, target.versionId).inputSchema, confirmation: false };
    }
    const tool = this.bridge.tools(target.applicationId).find(item => item.toolId === target.toolId);
    check(tool?.enabled && bridgeToolHash(tool) === target.contractDigest && target.timeoutMs <= tool.timeoutMs &&
      (this.bridge.config?.application(target.applicationId)?.enabled ?? true), "TARGET_CHANGED", "浏览器工具配置已变化，请重新选择");
    check(!target.credentialBindings || tool.execution?.transport === "browser", "INVALID_CREDENTIALS", "只有浏览器执行可绑定凭据");
    if (tool.execution) {
      const env = this.bridge.config?.environments(target.applicationId).find(item => item.id === target.environmentId);
      check(env?.enabled && digest(canonicalJson(env)) === target.environmentDigest, "ENVIRONMENT_CHANGED", "运行环境已变化，请重新选择");
    } else check(target.environmentId === null && target.environmentDigest === null, "INVALID_ENVIRONMENT", "该工具无需运行环境");
    return { target, schema: tool.parameters, confirmation: tool.risk !== "read" || tool.approval !== "none" };
  }
}

const protect = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(protect);
    if (!object(value)) return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, protect(child)]));
    if (value.sensitive === true || value.writeOnly === true) result["x-history"] = { record: false };
    return result;
  };
export function isSensitiveField(schema: JsonSchema, field: string) {
  const marker = Object.fromEntries([[field, ""]]);
  const masked = captureHistory(marker, protect(schema) as JsonSchema);
  if (Object.keys(masked.sources).length > 0) return true;
  const property = object(schema) && object(schema.properties) ? schema.properties[field] : undefined;
  // An object reference can contain nested values that are hidden at arbitrary paths.
  const containsPolicy = (node: unknown): boolean => Array.isArray(node) ? node.some(containsPolicy) :
    object(node) && (node.sensitive === true || node.writeOnly === true || node.$ref !== undefined ||
      (object(node["x-history"]) && node["x-history"].record === false) || Object.values(node).some(containsPolicy));
  return containsPolicy(property);
}

export function checkInput(input: unknown, sources: unknown, schema: JsonSchema): InputSources {
  check(schema !== false, "INVALID_SCHEMA", "目标不接受输入");
  check(object(sources), "INVALID_SOURCES", "参数引用必须为对象");
  const properties = object(schema) && schema.type === "object" && object(schema.properties) ? schema.properties : {};
  const inputSources: InputSources = Object.create(null);
  for (const [path, ref] of Object.entries(sources)) {
    const key = Object.keys(properties).find(name => "/" + pointerPart(name) === path);
    check(key !== undefined && object(input) && !Object.hasOwn(input, key), "INVALID_SOURCE_PATH", "引用必须绑定到未填写手动值的已声明顶层字段");
    check(object(ref) && ref.source === "dictionary", "DICTIONARY_REFERENCE_REQUIRED", "请将旧参数引用替换为字典引用");
    assertSchema(ref, shape({ source: { const: "dictionary" }, dictionaryId: id, key: id }), "参数引用");
    inputSources[path] = ref as InputSource;
  }
  const privacySchema = protect(schema) as JsonSchema;
  const captured = captureHistory(input, privacySchema);
  check(!Object.values(captured.sources).some(source => source.source === "omitted"), "SENSITIVE_INPUT", "敏感字段必须使用引用");
  if (!Object.keys(inputSources).length) assertSchema(input, schema, "运行参数");
  return inputSources;
}

export function resolveInput(input: unknown, sources: InputSources, readDictionary: (id: string, key: string, field: string) => unknown) {
  if (!Object.keys(sources).length) return input;
  const result = { ...input as Record<string, unknown> };
  for (const [path, ref] of Object.entries(sources)) {
    const key = path.slice(1).replace(/~1/g, "/").replace(/~0/g, "~");
    const value = readDictionary(ref.dictionaryId, ref.key, key);
    Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
