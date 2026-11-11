import Ajv from "ajv";
import { WORKFLOW_CREDENTIAL_BINDINGS_SCHEMA } from "../web-bridge/credential-inputs.js";
import { dictionaryBindingsSchema, dictionaryIdSchema, dictionaryKeySchema, normalizeDictionaryBindings } from "./dictionaries.js";
import { check, AppError } from "./errors.js";
import type { Binding, JsonSchema, Workflow, WorkflowNode } from "./types.js";

const ajv = new Ajv({ strict: true, allErrors: true, allowUnionTypes: true });
ajv.addKeyword({
  keyword: "x-ui", schemaType: "object",
  metaSchema: {
    type: "object", additionalProperties: false,
    properties: {
      widget: { enum: ["input", "textarea"] },
      rows: { type: "integer", minimum: 2, maximum: 30 },
      placeholder: { type: "string", maxLength: 1000 },
    },
  },
  compile: (config, parentSchema) => {
    if (parentSchema.type !== "string") throw new Error("x-ui 仅支持 string 参数");
    if (config.rows !== undefined && config.widget !== "textarea") throw new Error("rows 仅适用于 textarea");
    return () => true;
  },
});
ajv.addKeyword({
  keyword: "x-history", schemaType: "object", valid: true,
  metaSchema: { type: "object", required: ["record"], additionalProperties: false, properties: { record: { type: "boolean" } } },
});
const schemaValue = { anyOf: [{ type: "boolean" }, { type: "object" }] };
const bindingSchema = {
  $id: "binding",
  oneOf: [
    { type: "object", required: ["source", "value"], properties: { source: { const: "literal" }, value: {} }, additionalProperties: false },
    { type: "object", required: ["source"], properties: { source: { const: "workflow" }, pointer: { type: "string" } }, additionalProperties: false },
    { type: "object", required: ["source", "nodeId"], properties: { source: { const: "node" }, nodeId: { type: "string" }, pointer: { type: "string" } }, additionalProperties: false },
    { type: "object", required: ["source", "dictionaryId", "key"], properties: { source: { const: "dictionary" }, dictionaryId: dictionaryIdSchema, key: dictionaryKeySchema, pointer: { type: "string" } }, additionalProperties: false },
    { type: "object", required: ["source", "properties"], properties: { source: { const: "object" }, properties: { type: "object", additionalProperties: { $ref: "binding" } } }, additionalProperties: false },
    { type: "object", required: ["source", "items"], properties: { source: { const: "array" }, items: { type: "array", items: { $ref: "binding" } } }, additionalProperties: false },
  ],
};
ajv.addSchema(bindingSchema);
const choiceSchema = { type: "object", properties: { agentConfigId: { type: "string", minLength: 1, maxLength: 200 } }, additionalProperties: false };
const validateShape = ajv.compile({
  type: "object", required: ["formatVersion", "id", "name", "inputSchema", "outputSchema", "entryNodeId", "nodes", "edges", "result"],
  properties: {
    formatVersion: { const: 1 }, id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,99}$" }, name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 4000 }, inputSchema: schemaValue, outputSchema: schemaValue, entryNodeId: { type: "string" },
    defaults: { type: "object", properties: { agent: choiceSchema }, additionalProperties: false },
    nodes: { type: "array", minItems: 1, maxItems: 100, items: {
      type: "object", required: ["id", "name", "type", "input", "outputSchema", "config"],
      properties: { id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,99}$" }, name: { type: "string", minLength: 1 }, type: { enum: ["code.nodejs", "agent", "shell", "script", "switch", "web-bridge"] }, input: { $ref: "binding" }, inputSchema: schemaValue, outputSchema: schemaValue, config: { type: "object" } }, additionalProperties: false,
    } },
    edges: { type: "array", maxItems: 300, items: { type: "object", required: ["id", "from", "to"], properties: { id: { type: "string", minLength: 1 }, from: { type: "string" }, to: { type: ["string", "null"] }, label: { type: "string", minLength: 1 } }, additionalProperties: false } },
    result: { $ref: "binding" },
  }, additionalProperties: false,
});
const timeout = { type: "integer", minimum: 1, maximum: 1800000 };
function validateConfig(node: WorkflowNode) {
  const properties = node.type === "agent"
    ? { project: { type: "object", required: ["projectId"], properties: { projectId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$" } }, additionalProperties: false }, agentConfigId: { type: "string", minLength: 1, maxLength: 200 }, prompt: { type: "string", minLength: 1, maxLength: 100000 }, timeoutMs: timeout }
    : node.type === "switch"
      ? { cases: { type: "array", maxItems: 100, items: { type: "object", required: ["label", "value"], properties: { label: { type: "string", minLength: 1 }, value: { type: ["string", "number", "boolean", "null"] } }, additionalProperties: false } }, defaultLabel: { type: "string", minLength: 1 } }
      : node.type === "script"
        ? { scriptId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,99}$" }, scriptVersionId: { type: "string", minLength: 1 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 } }
        : node.type === "web-bridge"
          ? { credentialBindings: WORKFLOW_CREDENTIAL_BINDINGS_SCHEMA, environmentId: { type: "string", minLength: 1, maxLength: 100 }, application: { type: "string", pattern: "^[a-z][a-z0-9-]{0,49}$" }, tool: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,99}$" }, timeoutMs: timeout, resultMode: { enum: ["result", "envelope"] } }
          : { script: { type: "string", pattern: "^scripts/" }, dictionaryBindings: dictionaryBindingsSchema, timeoutMs: timeout, ...(node.type === "shell" ? { resultMode: { enum: ["process", "json"] } } : {}) };
  const required = node.type === "agent" ? ["prompt"] : node.type === "switch" ? ["cases", "defaultLabel"] : node.type === "script" ? ["scriptId", "scriptVersionId"] : node.type === "web-bridge" ? ["application", "tool"] : ["script"];
  assertSchema(node.config, { type: "object", required, properties, additionalProperties: false }, `${node.id} 配置`);
  normalizeDictionaryBindings(node.config.dictionaryBindings);
}
export function assertSchema(value: unknown, schema: JsonSchema, context = "值") {
  let validate;
  try {
    check(typeof schema === "boolean" || schema !== null && typeof schema === "object" && !Array.isArray(schema), "INVALID_SCHEMA", `${context} Schema 必须为对象或布尔值`);
    const encoded = JSON.stringify(schema);
    check(!encoded.includes('"$async"') && !encoded.includes('"$data"'), "INVALID_SCHEMA", "不支持异步或动态 Schema");
    validate = ajv.compile(schema);
  } catch (error) { throw new AppError("INVALID_SCHEMA", `${context}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!validate(value)) throw new AppError("SCHEMA_MISMATCH", `${context}: ${ajv.errorsText(validate.errors)}`);
}
export function pointer(value: unknown, path = ""): unknown {
  check(path === "" || path.startsWith("/") && !/~(?![01])/.test(path), "INVALID_BINDING", `JSON Pointer 无效: ${path}`);
  let current = value;
  for (const part of path ? path.slice(1).split("/").map(s => s.replace(/~1/g, "/").replace(/~0/g, "~")) : []) {
    check(current !== null && typeof current === "object" && Object.hasOwn(current, part), "MISSING_INPUT", `找不到输入路径 ${path}`);
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function walkBindings(binding: Binding, visit: (binding: Binding) => void) {
  visit(binding);
  if (binding.source === "object") Object.values(binding.properties).forEach(b => walkBindings(b, visit));
  if (binding.source === "array") binding.items.forEach(b => walkBindings(b, visit));
}
export type DictionaryBindingResolver = (dictionaryId: string, key: string) => unknown;
export function resolveBinding(binding: Binding, input: unknown, outputs: Map<string, unknown>, dictionaries?: DictionaryBindingResolver): unknown {
  switch (binding.source) {
    case "literal": return binding.value;
    case "workflow": return pointer(input, binding.pointer);
    case "node": check(outputs.has(binding.nodeId), "MISSING_INPUT", `节点 ${binding.nodeId} 尚无结果`); return pointer(outputs.get(binding.nodeId), binding.pointer);
    case "dictionary": {
      check(dictionaries, "DICTIONARY_ACCESS_DENIED", "字典绑定缺少固定版本上下文", 422);
      return structuredClone(pointer(dictionaries(binding.dictionaryId, binding.key), binding.pointer));
    }
    case "object": return Object.fromEntries(Object.entries(binding.properties).map(([key, b]) => [key, resolveBinding(b, input, outputs, dictionaries)]));
    case "array": return binding.items.map(b => resolveBinding(b, input, outputs, dictionaries));
  }
}
export function validateWorkflow(value: unknown): Workflow {
  check(validateShape(value), "INVALID_WORKFLOW", ajv.errorsText(validateShape.errors));
  const graph = value as Workflow;
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  check(nodes.size === graph.nodes.length, "INVALID_GRAPH", "节点 ID 重复");
  check(new Set(graph.edges.map(e => e.id)).size === graph.edges.length, "INVALID_GRAPH", "连线 ID 重复");
  check(nodes.has(graph.entryNodeId), "INVALID_GRAPH", "入口节点不存在");
  for (const edge of graph.edges) check(nodes.has(edge.from) && (edge.to === null || nodes.has(edge.to)), "INVALID_GRAPH", "连线引用了不存在的节点");
  const order: string[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    check(!visiting.has(id), "INVALID_GRAPH", "流程不允许存在环");
    if (visited.has(id)) return;
    visiting.add(id);
    graph.edges.filter(e => e.from === id && e.to !== null).forEach(e => visit(e.to!));
    visiting.delete(id); visited.add(id); order.unshift(id);
  };
  visit(graph.entryNodeId);
  check(visited.size === nodes.size, "INVALID_GRAPH", "存在入口不可达的节点");
  // The intersection of predecessor dominators identifies results available on EVERY path.
  const dominators = new Map<string, Set<string>>();
  const intersect = (sets: Set<string>[]) => new Set([...(sets[0] ?? [])].filter(id => sets.every(s => s.has(id))));
  for (const id of order) {
    const parents = graph.edges.filter(e => e.to === id).map(e => dominators.get(e.from)!);
    dominators.set(id, new Set([...intersect(parents), id]));
  }
  const exits = graph.nodes.filter(n => !graph.edges.some(e => e.from === n.id) || graph.edges.some(e => e.from === n.id && e.to === null));
  const endDominators = intersect(exits.map(n => dominators.get(n.id)!));
  const checkBinding = (binding: Binding, allowed: Set<string>) => walkBindings(binding, b => {
    if (b.source === "node") check(allowed.has(b.nodeId), "INVALID_BINDING", `节点 ${b.nodeId} 并非所有路径必经的前置节点`);
    if ((b.source === "node" || b.source === "workflow" || b.source === "dictionary") && b.pointer) check(b.pointer.startsWith("/") && !/~(?![01])/.test(b.pointer), "INVALID_BINDING", "JSON Pointer 无效");
  });
  for (const node of graph.nodes) {
    validateConfig(node);
    if (node.type === "agent") check(node.config.agentConfigId || graph.defaults?.agent?.agentConfigId, "AGENT_CONFIG_REQUIRED", `${node.name} 请选择 Agent 模型配置或设置工作流默认配置`);
    const outgoing = graph.edges.filter(e => e.from === node.id);
    if (node.type === "switch") {
      const cases = node.config.cases!, labels = [...cases.map(c => c.label), node.config.defaultLabel!];
      check(new Set(labels).size === labels.length && new Set(cases.map(c => JSON.stringify(c.value))).size === cases.length, "INVALID_GRAPH", "Switch 条件或标签重复");
      check(outgoing.length === labels.length && labels.every(label => outgoing.filter(e => e.label === label).length === 1), "INVALID_GRAPH", "Switch 每个分支及默认分支必须有唯一连线");
    } else check(outgoing.length <= 1 && outgoing.every(e => e.label === undefined), "INVALID_GRAPH", "普通节点仅支持单一后继");
    // Compile schemas without making their data validation a publish-time requirement.
    for (const schema of [node.inputSchema ?? true, node.outputSchema]) { try { assertSchema(null, schema); } catch (error) { if (!(error instanceof AppError) || error.code !== "SCHEMA_MISMATCH") throw error; } }
    const allowed = new Set(dominators.get(node.id)); allowed.delete(node.id); checkBinding(node.input, allowed);
  }
  checkBinding(graph.result, endDominators);
  for (const schema of [graph.inputSchema, graph.outputSchema]) { try { assertSchema(null, schema); } catch (error) { if (!(error instanceof AppError) || error.code !== "SCHEMA_MISMATCH") throw error; } }
  return graph;
}
export function diagnostics(value: unknown) {
  try { validateWorkflow(value); return { valid: true, diagnostics: [] as string[] }; }
  catch (error) { return { valid: false, diagnostics: [error instanceof Error ? error.message : String(error)] }; }
}
