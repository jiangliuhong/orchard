// Pure format recognition and conversion. No files or business services are opened here.
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export interface BridgeConfig extends JsonObject {
  schemaVersion: 1;
  applications: JsonObject;
  environments: JsonObject;
  tools: JsonObject;
  enabledTools: JsonObject;
}

export class ConfigFormatError extends Error {
  constructor(readonly code: string, readonly path: string) {
    // Never include a configuration value or parser exception in public errors.
    super(`${code}: ${path}`);
    this.name = "ConfigFormatError";
  }
}
const fail = (code: string, path: string): never => { throw new ConfigFormatError(code, path); };
const own = (value: JsonObject, key: string) => Object.hasOwn(value, key);
const pointer = (path: string, key: string) => `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
const object = (value: JsonValue | undefined, path: string): JsonObject => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CONFIG_INVALID_OBJECT", path);
  return value as JsonObject;
};
const string = (value: JsonValue | undefined, path: string, nonempty = true): string => {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail("CONFIG_INVALID_STRING", path);
  return value as string;
};
const boolean = (value: JsonValue | undefined, path: string) => {
  if (typeof value !== "boolean") fail("CONFIG_INVALID_BOOLEAN", path);
};

/** JSON.parse loses duplicate keys; recognize them before accepting any value.
 * Objects use null prototypes, including nested unknown fields and __proto__ keys.
 */
export function parseConfigJson(source: string): JsonValue {
  let index = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[index] ?? "!") ) index++; };
  const invalid = (): never => fail("CONFIG_INVALID_JSON", "");
  const quoted = (): string => {
    if (source[index] !== '"') return invalid();
    const start = index++;
    while (index < source.length) {
      const char = source[index++];
      if (char === '"') {
        try { return JSON.parse(source.slice(start, index)) as string; } catch { return invalid(); }
      }
      if (char === "\\") index++;
    }
    return invalid();
  };
  const value = (path: string, depth: number): JsonValue => {
    if (depth > 256) fail("CONFIG_TOO_DEEP", path);
    whitespace();
    const char = source[index];
    if (char === '"') return quoted();
    if (char === "{" || char === "[") {
      index++;
      const isObject = char === "{", end = isObject ? "}" : "]";
      const result: JsonObject | JsonValue[] = isObject ? Object.create(null) as JsonObject : [];
      whitespace();
      if (source[index] === end) { index++; return result; }
      while (index < source.length) {
        whitespace();
        if (isObject) {
          const key = quoted(), child = pointer(path, key);
          if (own(result as JsonObject, key)) fail("CONFIG_DUPLICATE_KEY", child);
          whitespace();
          if (source[index++] !== ":") return invalid();
          (result as JsonObject)[key] = value(child, depth + 1);
        } else (result as JsonValue[]).push(value(`${path}/${(result as JsonValue[]).length}`, depth + 1));
        whitespace();
        if (source[index] === end) { index++; return result; }
        if (source[index++] !== ",") return invalid();
      }
      return invalid();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(index))?.[0];
    if (!token) return invalid();
    index += token.length;
    const parsed: JsonValue = JSON.parse(token);
    if (typeof parsed === "number" && !Number.isFinite(parsed)) fail("CONFIG_INVALID_NUMBER", path);
    return parsed;
  };
  const result = value("", 0);
  whitespace();
  if (index !== source.length) return invalid();
  return result;
}

const mappings = ["applications", "environments", "tools", "enabledTools"] as const;
const applicationId = /^[a-z][a-z0-9-]{0,49}$/;
const toolId = /^[a-z][a-z0-9_-]{0,99}$/;
function toolKey(key: string, path: string): [string, string] {
  const parts = key.split("/");
  if (parts.length !== 2 || !applicationId.test(parts[0]) || !toolId.test(parts[1])) fail("CONFIG_INVALID_TOOL_KEY", path);
  return [parts[0], parts[1]];
}

/** Mirrors the existing environment save rule, without network or browser access. */
export function isBridgeOrigin(value: string): boolean {
  return /^https:\/\/[^/]+$/.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(value);
}

function validateMappings(config: JsonObject): void {
  const applications = object(config.applications, "/applications");
  const environments = object(config.environments, "/environments");
  const tools = object(config.tools, "/tools");
  const switches = object(config.enabledTools, "/enabledTools");
  const reference = (id: string, path: string) => {
    if (!own(applications, id)) fail("CONFIG_UNKNOWN_APPLICATION", path);
  };
  for (const [key, raw] of Object.entries(applications)) {
    const path = pointer("/applications", key), app = object(raw, path);
    const id = string(app.id, `${path}/id`);
    if (id !== key) fail("CONFIG_KEY_MISMATCH", `${path}/id`);
    string(app.name, `${path}/name`);
    boolean(app.enabled, `${path}/enabled`);
  }
  for (const [key, raw] of Object.entries(environments)) {
    const path = pointer("/environments", key);
    reference(key, path);
    if (!Array.isArray(raw)) fail("CONFIG_INVALID_ARRAY", path);
    const ids = new Set<string>();
    for (const [index, entry] of (raw as JsonValue[]).entries()) {
      const at = `${path}/${index}`, env = object(entry, at), id = string(env.id, `${at}/id`);
      if (ids.has(id)) fail("CONFIG_DUPLICATE_ENVIRONMENT", `${at}/id`);
      ids.add(id);
      if (!isBridgeOrigin(string(env.origin, `${at}/origin`))) fail("CONFIG_INVALID_ORIGIN", `${at}/origin`);
      for (const field of ["enabled", "bound", "tabAvailable"]) boolean(env[field], `${at}/${field}`);
      for (const field of ["profileId", "extensionId"]) if (own(env, field)) string(env[field], `${at}/${field}`, false);
    }
  }
  for (const [key, raw] of Object.entries(tools)) {
    const path = pointer("/tools", key), [appId, id] = toolKey(key, path), tool = object(raw, path);
    reference(appId, path);
    if (string(tool.application, `${path}/application`) !== appId || string(tool.toolId, `${path}/toolId`) !== id) fail("CONFIG_KEY_MISMATCH", path);
    for (const field of ["site", "description", "catalogVersion"]) string(tool[field], `${path}/${field}`, false);
    object(tool.parameters, `${path}/parameters`);
    const target = string(tool.path, `${path}/path`);
    // Backslashes and control characters can normalize to a cross-origin URL.
    if (!/^\/[^/]/.test(target) || /[\\\u0000-\u0020\u007f]/.test(target)) fail("CONFIG_INVALID_PATH", `${path}/path`);
    for (const [field, allowed] of [["method", ["GET", "POST"]], ["risk", ["read", "write", "delete", "execute", "download"]], ["approval", ["none", "user"]]] as const) {
      if (!(allowed as readonly JsonValue[]).includes(tool[field])) fail("CONFIG_INVALID_ENUM", `${path}/${field}`);
    }
    if (!Array.isArray(tool.fields) || tool.fields.some(field => typeof field !== "string")) fail("CONFIG_INVALID_ARRAY", `${path}/fields`);
    if (typeof tool.timeoutMs !== "number" || !Number.isFinite(tool.timeoutMs) || tool.timeoutMs < 100 || tool.timeoutMs > 120000) fail("CONFIG_INVALID_TIMEOUT", `${path}/timeoutMs`);
    boolean(tool.enabled, `${path}/enabled`);
  }
  for (const [key, enabled] of Object.entries(switches)) {
    const path = pointer("/enabledTools", key);
    toolKey(key, path);
    boolean(enabled, path);
  }
}

export function inspectBridgeConfig(source: string): { version: 0 | 1; value: JsonObject } {
  const value = object(parseConfigJson(source), "");
  let version: 0 | 1 = 0;
  if (own(value, "schemaVersion")) {
    if (value.schemaVersion !== 1) fail(typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion > 1 ? "CONFIG_VERSION_TOO_NEW" : "CONFIG_UNKNOWN_VERSION", "/schemaVersion");
    version = 1;
  } else if (Object.keys(value).length && !mappings.some(key => own(value, key))) fail("CONFIG_UNKNOWN_FORMAT", "");
  const complete: JsonObject = Object.assign(Object.create(null), value);
  for (const key of mappings) {
    if (!own(value, key)) {
      if (version === 1) fail("CONFIG_MISSING_FIELD", `/${key}`);
      complete[key] = Object.create(null) as JsonObject;
    }
  }
  validateMappings(complete);
  return { version, value };
}

export function validateBridgeConfigV1(source: string): BridgeConfig {
  const inspected = inspectBridgeConfig(source);
  if (inspected.version !== 1) fail("CONFIG_MIGRATION_REQUIRED", "/schemaVersion");
  return inspected.value as BridgeConfig;
}

export function migrateBridgeConfigV0(source: string): BridgeConfig {
  const { version, value } = inspectBridgeConfig(source);
  if (version !== 0) fail("CONFIG_SOURCE_VERSION_MISMATCH", "/schemaVersion");
  const result: JsonObject = Object.assign(Object.create(null), value, { schemaVersion: 1 });
  for (const key of mappings) if (!own(result, key)) result[key] = Object.create(null) as JsonObject;
  return validateBridgeConfigV1(JSON.stringify(result));
}

export function defaultBridgeConfig(): BridgeConfig {
  return migrateBridgeConfigV0("{}");
}
