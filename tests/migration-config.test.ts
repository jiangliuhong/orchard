import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConfigFormatError, defaultBridgeConfig, inspectBridgeConfig, migrateBridgeConfigV0, parseConfigJson, validateBridgeConfigV1 } from "../src/migrations/config.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/migrations/config/${name}.json`, import.meta.url), "utf8");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function rejects(source: string, code: string, path?: string) {
  assert.throws(() => inspectBridgeConfig(source), error => error instanceof ConfigFormatError && error.code === code && (path === undefined || error.path === path));
}

test("v0 fixtures migrate without changing any existing JSON values", () => {
  for (const name of ["v0-empty", "v0-partial", "v0-full"]) {
    const source = fixture(name), original = JSON.parse(source), result = migrateBridgeConfigV0(source);
    assert.equal(inspectBridgeConfig(source).version, 0);
    assert.equal(result.schemaVersion, 1);
    for (const key of Object.keys(original)) assert.deepEqual(plain(result[key]), original[key]);
    for (const key of ["applications", "environments", "tools", "enabledTools"]) assert.ok(Object.hasOwn(result, key));
    assert.deepEqual(plain(validateBridgeConfigV1(JSON.stringify(result))), plain(result));
  }
});

test("v1 validation preserves unknown fields and does not fill missing mappings", () => {
  const source = fixture("v1-full");
  assert.deepEqual(plain(validateBridgeConfigV1(source)), JSON.parse(source));
  rejects('{"schemaVersion":1}', "CONFIG_MISSING_FIELD", "/applications");
  assert.throws(() => validateBridgeConfigV1("{}"), { code: "CONFIG_MIGRATION_REQUIRED" });
  assert.throws(() => migrateBridgeConfigV0(source), { code: "CONFIG_SOURCE_VERSION_MISMATCH" });
  assert.deepEqual(plain(defaultBridgeConfig()), { schemaVersion: 1, applications: {}, environments: {}, tools: {}, enabledTools: {} });
});

test("unknown formats, corrupt JSON and explicitly invalid versions cannot become defaults", () => {
  for (const source of ["", " ", "{", '{"applications":{},}', '{"applications":{} "tools":{}}', '{"applications":{},"unknown":01}', '{"applications":{},"unknown":"bad\ntext"}']) rejects(source, "CONFIG_INVALID_JSON");
  for (const source of ["null", "[]", "true", '"text"', "4"]) rejects(source, "CONFIG_INVALID_OBJECT");
  rejects('{"unknown":{}}', "CONFIG_UNKNOWN_FORMAT");
  for (const version of [null, false, "1", 0, -1, 1.5]) rejects(JSON.stringify({ schemaVersion: version }), "CONFIG_UNKNOWN_VERSION", "/schemaVersion");
  rejects('{"schemaVersion":2}', "CONFIG_VERSION_TOO_NEW", "/schemaVersion");
  for (const key of ["applications", "environments", "tools", "enabledTools"]) {
    for (const value of [null, [], false, "bad"]) rejects(JSON.stringify({ [key]: value }), "CONFIG_INVALID_OBJECT", `/${key}`);
  }
});

test("duplicate keys are rejected at any depth including escaped equivalents", () => {
  rejects('{"applications":{},"applications":{}}', "CONFIG_DUPLICATE_KEY", "/applications");
  rejects('{"applications":{},"custom":{"key":1,"ke\\u0079":2}}', "CONFIG_DUPLICATE_KEY", "/custom/key");
  rejects('{"applications":{},"custom":[{"x":1,"x":2}]}', "CONFIG_DUPLICATE_KEY", "/custom/0/x");
});

test("prototype keys remain ordinary preserved JSON data", () => {
  const result = migrateBridgeConfigV0('{"applications":{},"__proto__":{"polluted":true},"custom":{"constructor":{"prototype":1}}}');
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.__proto__), null);
  assert.deepEqual(plain(result.__proto__), { polluted: true });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  rejects('{"applications":{},"environments":{"toString":[]}}', "CONFIG_UNKNOWN_APPLICATION");
});

test("application and environment invariants identify field paths", () => {
  const source = () => JSON.parse(fixture("v0-full"));
  const bad = source(); bad.applications.sample.id = "other";
  rejects(JSON.stringify(bad), "CONFIG_KEY_MISMATCH", "/applications/sample/id");
  for (const field of ["id", "name", "enabled"]) {
    const value = source(); delete value.applications.sample[field];
    rejects(JSON.stringify(value), field === "enabled" ? "CONFIG_INVALID_BOOLEAN" : "CONFIG_INVALID_STRING");
  }
  const duplicate = source(); duplicate.environments.sample.push(duplicate.environments.sample[0]);
  rejects(JSON.stringify(duplicate), "CONFIG_DUPLICATE_ENVIRONMENT", "/environments/sample/1/id");
  for (const origin of ["https://example.test/path", "http://remote.test", "https://example.test/"]) {
    const value = source(); value.environments.sample[0].origin = origin;
    rejects(JSON.stringify(value), "CONFIG_INVALID_ORIGIN");
  }
  for (const field of ["enabled", "bound", "tabAvailable"]) {
    const value = source(); value.environments.sample[0][field] = "yes";
    rejects(JSON.stringify(value), "CONFIG_INVALID_BOOLEAN");
  }
});

test("tool validation covers enums, references, schema, fields, path and timeout", () => {
  const source = () => JSON.parse(fixture("v0-full"));
  const cases: [string, unknown, string][] = [
    ["application", "other", "CONFIG_KEY_MISMATCH"], ["toolId", "other", "CONFIG_KEY_MISMATCH"],
    ["parameters", [], "CONFIG_INVALID_OBJECT"], ["fields", [1], "CONFIG_INVALID_ARRAY"],
    ["path", "//remote.test/a", "CONFIG_INVALID_PATH"], ["path", "/\\remote.test/a", "CONFIG_INVALID_PATH"],
    ["path", "/\t/remote.test", "CONFIG_INVALID_PATH"], ["method", "PUT", "CONFIG_INVALID_ENUM"],
    ["risk", "unknown", "CONFIG_INVALID_ENUM"], ["approval", "auto", "CONFIG_INVALID_ENUM"],
    ["timeoutMs", 99, "CONFIG_INVALID_TIMEOUT"], ["timeoutMs", 120001, "CONFIG_INVALID_TIMEOUT"],
    ["timeoutMs", "100", "CONFIG_INVALID_TIMEOUT"], ["enabled", 1, "CONFIG_INVALID_BOOLEAN"],
  ];
  for (const [field, value, code] of cases) {
    const data = source(); data.tools["sample/list"][field] = value;
    rejects(JSON.stringify(data), code);
  }
  const dangling = source(); delete dangling.applications.sample;
  rejects(JSON.stringify(dangling), "CONFIG_UNKNOWN_APPLICATION");
  const badSwitch = source(); badSwitch.enabledTools["sample/unregistered"] = "yes";
  rejects(JSON.stringify(badSwitch), "CONFIG_INVALID_BOOLEAN");
  rejects('{"enabledTools":{"invalid/key/extra":true}}', "CONFIG_INVALID_TOOL_KEY");
  assert.equal(migrateBridgeConfigV0('{"enabledTools":{"sample/not_registered":false}}').enabledTools["sample/not_registered"], false);
});

test("parser handles JSON string escapes, rejects trailing bytes and bounds nesting", () => {
  const original = { applications: {}, custom: ['a"b', "c\\d", "汉字", -1.25e-10, true, null, [], {}] };
  assert.deepEqual(plain(parseConfigJson(JSON.stringify(original))), original);
  rejects('{"applications":{}}false', "CONFIG_INVALID_JSON");
  rejects('{"applications":{},"custom":1e999}', "CONFIG_INVALID_NUMBER");
  rejects('{"applications":{},"custom":' + '['.repeat(260) + '0' + ']'.repeat(260) + '}', "CONFIG_TOO_DEEP");
  const secret = "PRIVATE_VALUE_DO_NOT_PRINT";
  try { inspectBridgeConfig(JSON.stringify({ applications: secret })); assert.fail("Expected failure"); }
  catch (error) { assert.ok(error instanceof ConfigFormatError); assert.ok(!error.message.includes(secret)); }
});
