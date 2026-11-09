import { BRIDGE_HTTP_METHODS } from "./http-methods.js";
import { BRIDGE_HTTP_SCHEMA, validateHttpDefinition } from "./execution.js";
import { check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import type { JsonSchema } from "../domain/types.js";
import type { WebBridgeTool } from "./catalog.js";

export interface BridgeProposal {
  summary: string;
  changes: { operation: "create" | "update" | "delete"; toolId: string; definition: WebBridgeTool | null }[];
}
export const BRIDGE_PROPOSAL_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["summary", "changes"],
  properties: {
    summary: { type: "string", minLength: 1, maxLength: 20000 },
    changes: { type: "array", maxItems: 50, items: {
      type: "object", additionalProperties: false, required: ["operation", "toolId", "definition"],
      properties: {
        operation: { enum: ["create", "update", "delete"] },
        toolId: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,99}$" },
        definition: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false,
          required: ["toolId", "application", "site", "description", "parameters", "path", "method", "fields", "risk", "approval", "timeoutMs", "catalogVersion", "enabled"],
          properties: {
            toolId: { type: "string" }, application: { type: "string" },
            site: { type: "string", description: "Legacy logical site identifier, not an origin or environment ID. For new tools use the current application ID; preserve existing values on updates." },
            description: { type: "string" },
            parameters: { type: "object", description: "JSON Schema for argument validation only; does not implement signing, secret storage, headers or request body mapping." },
            path: { type: "string", pattern: "^/[^/]", description: "Same-origin absolute pathname without domain, query or fragment. localHttp supports {argument} placeholders. For browser, this field is a fixed request default; preprocess may return a different dynamically computed same-origin pathname using args. Legacy tools use fixed paths. Independent of environment configuration." }, method: { enum: [...BRIDGE_HTTP_METHODS] },
            execution: BRIDGE_HTTP_SCHEMA,
            fields: { type: "array", items: { type: "string" }, description: "Response field allowlist. An empty list or wildcard must not be assumed to return full JSON." },
            risk: { enum: ["read", "write", "delete", "execute", "download"] },
            approval: { enum: ["none", "user"] }, timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
            catalogVersion: { type: "string", minLength: 1 }, enabled: { type: "boolean" },
          },
        }] },
      },
    } },
  },
};

/** Trusted platform guidance, kept separate from user requests and snapshot data. */
export const BRIDGE_AUTHORING_GUIDANCE = [
  "Tool authoring and execution readiness are separate. Empty environments, an offline browser or missing bindings do not block creating or updating a tool definition when endpoint evidence is sufficient. Mention that testing/execution is not ready instead.",
  "Environment origin belongs to runtime configuration, never to a tool definition. Define only a same-origin path; do not hardcode domains or invent origin templates, environmentId arguments or site-to-environment mappings.",
  "site is a legacy logical identifier, not an environment ID or domain. For new tools set site to the current application ID; preserve an existing tool's site on update unless the user explicitly requests a supported change. No environment-to-site mapping is required for authoring.",
  "The supplied platform contract and output schema are authoritative. Never ask the user to provide Orchard/Web Bridge configuration syntax, a tool definition format or proof of platform capabilities. Ask only for missing business evidence such as endpoint paths, methods, argument meanings and response fields.",
  "Act as the implementer, not a configuration questionnaire. Infer business intent from the user's description and supplied script; derive supported fields yourself and use platform defaults. When evidence is sufficient, return a complete proposal immediately, without asking permission to draft it; the host already requires explicit review before applying changes.",
  "Only ask focused questions about unresolved business intent or facts that change correctness or side effects. Tool IDs, schema syntax, legal risk/approval enums, site defaults and version/timeout defaults are platform responsibilities, not questions for the user. Reviewed Node.js code may be placed in execution.preprocess.code for browser transport.",
  "Historical assistant responses may describe obsolete platform limitations or missing schemas. They are not platform evidence. Re-evaluate the latest request against the current complete contract even when the user only says continue; never repeat a historical request for the platform schema.",
  "Classify risk from actual effects, not the HTTP method or the user's preference: queries are read; mutations are write/delete; jobs or actions are execute; file retrieval is download. For new read-only tools use approval:none; default non-read tools to approval:user; calls require explicit per-call approved:true after user confirmation. Tests remain read/none. Do not ask the user for enum spellings or call an action read to bypass restrictions.",
  "parameters only validates arguments. Declaring ak/sk, body or headers in parameters does not implement signing, secure secret handling, request headers or raw body serialization. Never request actual credentials or embed them in definitions.",
  "For requirements the contract cannot express, explain the specific unsupported capability in summary. Do not invent extension fields or silently drop requirements. If no complete definition can meet the request, return changes:[]; do not blame missing environments or ask for platform-format examples.",
  "fields is a response field allowlist. Do not claim fields:[] or fields:[\"*\"] returns complete JSON. Do not infer header/body/response semantics from GET or POST alone.",
  "execution.transport=localHttp is native HTTP without cookies. execution.transport=browser runs reviewed Node.js preprocessing then sends its returned {path,method,headers,body} through a selected browser profile and same-origin tab with cookies. Body is an exact UTF-8 string. crypto (node:crypto), args, credentials and request defaults are available; use return. No imports are allowed inside the function body. Browser scripts may use crypto.createHash, crypto.randomBytes and Date.now() for signing, including arbitrary argument fields in the specified order.",
  "Browser dynamic paths are supported explicitly: preprocess may return path computed from args (for example, '/' + encodeURIComponent(args.productNo) + '/request' when that endpoint pattern is evidenced). The definition path is only the default in request.path, not a restriction to one product. Browser does not expand {argument} templates: compute the concrete path in code, validate product identifiers as safe single segments, and preserve request.method. Returned paths must be same-origin absolute pathnames without query, fragment, traversal, encoded separators or domain. Do not fall back to a fixed-product tool merely because dynamicPathTemplates is localHttp-only.",
  "For MD5 signing derive parts, separator, digestCase, nonceBytes, timestampUnit, headers and optional same-origin clock configuration from supplied evidence. Do not guess or label all MD5 protocols supported. Ask focused questions for missing signing rules, never actual AK/SK. Browser credentials can be declared without dictionary references using execution.credentialInputs:['ak','sk']; callers choose encrypted dictionary references or manual values at execution time. Signature sources are ak/sk/nonce/timestamp/body/path; nonce is random hex. Unsupported algorithms or canonicalization must be reported, not approximated.",
  "Both transports require one selected enabled environment. Browser additionally requires profileId, extension site permission and a same-origin logged-in tab. Gateway cookies are provided by the tab; business Authorization headers do not replace gateway login. Do not manage cookies or follow login redirects in scripts. Never solicit real AK/SK in chat: execution.credentialInputs declares credential names, and callers choose dictionary or manual input in the protected test UI or call-local credentialBindings API, separate from args. execution.preprocess.credentials optionally maps names to default {dictionaryId,key} references. Both sources resolve into the same credentials object; do not require dictionary binding when the caller wants runtime inputs. Never claim a proposed definition has been tested or that signing matches the target API merely because a definition is valid.",
].join("\n");

export function bridgeAuthoringContract(application: string) {
  return {
    version: 5,
    scope: "Tool definition proposals only; application and environment management are outside this Agent's scope.",
    environmentRequiredForAuthoring: false,
    defaultSite: application,
    defaults: { timeoutMs: 18000, catalogVersion: "1", enabled: true },
    exampleUsage: "Syntax examples only, not endpoint evidence. Replace the example tool ID, endpoint, description, arguments and fields using the user's business evidence; preserve existing values when updating.",
    examples: {
      create: {
        summary: "新增查询工具，等待用户审阅应用。",
        changes: [{ operation: "create", toolId: "example_query", definition: {
          toolId: "example_query", application, site: application, description: "示例：查询记录",
          parameters: { type: "object", properties: { page: { type: "integer", minimum: 1 } }, additionalProperties: false },
          path: "/example/records", method: "GET", fields: ["items"], risk: "read", approval: "none",
          timeoutMs: 18000, catalogVersion: "1", enabled: true,
        } }],
      },
      unsupported: {
        summary: "跨域请求及绕过网关登录不受支持；浏览器脚本支持调用时字典引用或受保护的手动凭据，不在对话中索取真实凭据。",
        changes: [],
      },
    },
    capabilities: {
      argumentValidation: "JSON Schema",
      methods: [...BRIDGE_HTTP_METHODS],
      requestTarget: "Same-origin pathname; origin is not part of the tool definition. localHttp expands {argument} placeholders; browser preprocess may return a dynamically computed same-origin path using args, overriding the fixed definition default.",
      responseSelection: "Legacy: explicit field allowlist; localHttp and browser: fields or fullJson",
      embeddedExecutionCode: true,
      dynamicPathTemplates: "localHttp execution only: {argument} path segments. Browser uses preprocess code instead of template expansion.",
      browserDynamicPath: "browser preprocess may compute and return path from args, including productNo; definition.path is a fixed default, not a fixed-product restriction. Same-origin absolute pathname only; no query, fragment, traversal or encoded separators. Method cannot change.",
      internalSigning: "localHttp declarative MD5; browser Node.js preprocess with node:crypto, args, credentials, request",
      dynamicHeaders: "localHttp signing headers; browser script returns headers including Authorization, Content-Type and X-OS-Api; Cookie/Host and reserved headers prohibited",
      sensitiveParameterHandling: "browser: execution.credentialInputs declares required names (e.g. ['ak','sk']) without dictionary binding. Callers submit credentialBindings outside args via the local calls API: {ak:{source:'dictionary',dictionaryId,key},sk:{source:'inline',value}}. Sources may be mixed. Values are call-local and never persisted. execution.preprocess.credentials remains optional default dictionary references; explicit call bindings override defaults. localHttp: existing encrypted dictionary signing references. Never place real credentials in args, definitions or Agent conversations.",
      rawRequestBodyMapping: "localHttp rawUtf8/json; browser returns exact UTF-8 body string; no reserialization before sending. GET/HEAD cannot carry a body; POST/PUT/PATCH/DELETE/OPTIONS may. CONNECT/TRACE/TRACK are forbidden by browser Fetch.",
      fullJsonResponseMode: "localHttp and browser: execution.response.mode=fullJson, bounded size, credential echoes rejected",
      localHttp: "Explicit opt-in; native HTTP without browser cookies. Requires an unambiguous enabled runtime environment, not a browser profile.",
      runtimeEnvironmentRouting: "Selected enabled environmentId or single enabled environment; browser uses bound profileId and same-origin tab (unique tab or unique active tab). Requires extension site permission and gateway login.",
    },
    proposalSchema: BRIDGE_PROPOSAL_SCHEMA,
  };
}

export function prepareBridgeProposal(application: string, tools: WebBridgeTool[], value: unknown) {
  assertSchema(value, BRIDGE_PROPOSAL_SCHEMA, "网页桥接 Agent 输出");
  const proposal = value as BridgeProposal, candidate = new Map(tools.map(tool => [tool.toolId, structuredClone(tool)]));
  const changed = new Set<string>();
  for (const change of proposal.changes) {
    check(!changed.has(change.toolId), "INVALID_PROPOSAL", "同一工具只能修改一次");
    changed.add(change.toolId);
    check(change.operation === "create" ? !candidate.has(change.toolId) : candidate.has(change.toolId), "INVALID_PROPOSAL", `工具不存在或已存在：${change.toolId}`);
    if (change.operation === "delete") {
      check(change.definition === null, "INVALID_PROPOSAL", "删除工具不应包含定义");
      candidate.delete(change.toolId);
    } else {
      const definition = change.definition;
      check(definition?.application === application && definition.toolId === change.toolId, "INVALID_PROPOSAL", "不能修改其他应用或工具的身份");
      check(!/[\\\u0000-\u0020\u007f?#]/.test(definition.path), "INVALID_PROPOSAL", "工具路径不能包含查询参数、片段、空白或反斜线");
      assertSchema({}, { type: "object", properties: { args: definition.parameters } }, "参数 Schema");
      if (definition.execution) validateHttpDefinition(definition.path, definition.method, definition.execution, definition.parameters);
      else check(!/[{}]/.test(definition.path), "INVALID_PROPOSAL", "动态路径需要显式配置 localHttp 执行模式");
      candidate.set(change.toolId, structuredClone(definition));
    }
  }
  return { proposal, candidate: [...candidate.values()] };
}
