import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, jsonDepth, parseStrictJson, compareUtf8Keys } from "../src/dictionaries/canonical.js";
import {
  DICTIONARY_LIMITS,
  validateDictionaryName,
  validateDictionaryDescription,
  validateDictionaryKey,
  validateDictionaryKind,
  validateEntries,
  plainEntryByteLength,
  portableContentHash,
  sameVersionContent,
  dictionaryUnavailableError,
  dictionaryKeyMissingError,
  type DictionaryVersionContent,
} from "../src/dictionaries/model.js";

const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`预期抛出 ${code}`);
};

const plainEntries = (entries: Record<string, unknown>) => validateEntries("plain", entries) as Record<string, { type: string; value: unknown }>;

test("字典名称校验：去除空白、码点长度与非法输入", () => {
  assert.equal(validateDictionaryName("订单服务"), "订单服务");
  assert.equal(validateDictionaryName("a".repeat(100)), "a".repeat(100));
  assert.equal(validateDictionaryName("配".repeat(100)), "配".repeat(100));
  throwsCode(() => validateDictionaryName(" 订单服务"), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryName("订单服务 "), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryName(""), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryName("a".repeat(101)), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryName(123), "INVALID_DICTIONARY");
});

test("字典说明与类型校验", () => {
  assert.equal(validateDictionaryDescription("配置说明"), "配置说明");
  assert.equal(validateDictionaryDescription("x".repeat(2000)), "x".repeat(2000));
  throwsCode(() => validateDictionaryDescription("x".repeat(2001)), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryDescription(undefined), "INVALID_DICTIONARY");
  assert.equal(validateDictionaryKind("plain"), "plain");
  assert.equal(validateDictionaryKind("encrypted"), "encrypted");
  throwsCode(() => validateDictionaryKind("secret"), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKind(null), "INVALID_DICTIONARY");
});

test("键名校验：区分大小写、拒绝点号与下划线开头", () => {
  assert.equal(validateDictionaryKey("baseUrl"), "baseUrl");
  assert.equal(validateDictionaryKey("a".repeat(100)), "a".repeat(100));
  assert.equal(validateDictionaryKey("A_9-z"), "A_9-z");
  throwsCode(() => validateDictionaryKey("__proto__"), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKey("9key"), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKey("a.b"), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKey(""), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKey("a".repeat(101)), "INVALID_DICTIONARY");
  throwsCode(() => validateDictionaryKey("键名"), "INVALID_DICTIONARY");
});

test("普通条目按类型严格校验，不做隐式转换", () => {
  const entries = plainEntries({
    str: { type: "string", value: "hello" },
    num: { type: "number", value: 3.5 },
    bool: { type: "boolean", value: false },
    json: { type: "json", value: { list: [1, null, true] } },
  });
  assert.deepEqual(entries.str, { type: "string", value: "hello" });
  assert.deepEqual(entries.json, { type: "json", value: { list: [1, null, true] } });
  throwsCode(() => plainEntries({ bad: { type: "string", value: 12 } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "number", value: "3" } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "number", value: Number.NaN } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "number", value: Number.POSITIVE_INFINITY } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "boolean", value: "true" } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "json", value: undefined } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "json", value: new Date() } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "json", value: { nested: Number.NaN } } }), "INVALID_DICTIONARY");
  // 字段集合固定，拒绝携带 encryptedValue 的普通条目与额外字段。
  throwsCode(() => plainEntries({ bad: { type: "string", value: "x", extra: 1 } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ bad: { type: "json", encryptedValue: {} } }), "INVALID_DICTIONARY");
});

test("JSON 嵌套深度限制为 32", () => {
  const build = (depth: number): unknown => {
    let value: unknown = null;
    for (let i = 0; i < depth; i++) value = { child: value };
    return value;
  };
  assert.equal(jsonDepth(build(32)), 32);
  assert.equal(plainEntries({ ok: { type: "json", value: build(32) } }).ok.type, "json");
  throwsCode(() => plainEntries({ bad: { type: "json", value: build(33) } }), "INVALID_DICTIONARY");
  assert.equal(jsonDepth("text"), 0);
});

test("条目限额：单值 64 KiB、键数 500、合计 1 MiB", () => {
  assert.equal(plainEntryByteLength({ type: "string", value: "a".repeat(DICTIONARY_LIMITS.valueMaxBytes) }), DICTIONARY_LIMITS.valueMaxBytes);
  throwsCode(() => plainEntries({ big: { type: "string", value: "a".repeat(DICTIONARY_LIMITS.valueMaxBytes + 1) } }), "INVALID_DICTIONARY");
  throwsCode(() => plainEntries({ big: { type: "number", value: 10 ** 400 } }), "INVALID_DICTIONARY");
  const manyKeys: Record<string, unknown> = {};
  for (let i = 0; i < DICTIONARY_LIMITS.maxKeys; i++) manyKeys[`k${i}`] = { type: "string", value: "v" };
  assert.equal(Object.keys(validateEntries("plain", manyKeys)).length, DICTIONARY_LIMITS.maxKeys);
  const tooMany: Record<string, unknown> = {};
  for (let i = 0; i <= DICTIONARY_LIMITS.maxKeys; i++) tooMany[`k${i}`] = { type: "string", value: "v" };
  throwsCode(() => validateEntries("plain", tooMany), "INVALID_DICTIONARY");
  const heavy: Record<string, unknown> = {};
  let total = 0;
  for (let i = 0; total <= DICTIONARY_LIMITS.totalMaxBytes; i++) {
    const chunk = "a".repeat(60 * 1024);
    heavy[`h${i}`] = { type: "string", value: chunk };
    total += chunk.length;
  }
  throwsCode(() => validateEntries("plain", heavy), "INVALID_DICTIONARY");
});

test("规范化：UTF-8 字节序排序、无空白、负零归一、拒绝非 JSON 值", () => {
  assert.equal(canonicalJson({ b: 1, A: 2, a: 3 }), '{"A":2,"a":3,"b":1}');
  // 码点 U+FFFD 与 emoji 的 UTF-8 字节序与码点序一致，仅验证稳定排序输出。
  assert.equal(canonicalJson({ "\u{1F600}": 1, "\uFFFD": 2 }), '{"\uFFFD":2,"\u{1F600}":1}');
  assert.equal(canonicalJson([3, 1, 2]), "[3,1,2]");
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.equal(canonicalJson({ nested: { x: [true, null, "s"] } }), '{"nested":{"x":[true,null,"s"]}}');
  throwsCode(() => canonicalJson(Number.NaN), "INVALID_JSON");
  throwsCode(() => canonicalJson(Number.POSITIVE_INFINITY), "INVALID_JSON");
  throwsCode(() => canonicalJson(undefined), "INVALID_JSON");
  throwsCode(() => canonicalJson(new Date()), "INVALID_JSON");
  throwsCode(() => canonicalJson(() => 1), "INVALID_JSON");
  const sparse: unknown[] = [];
  sparse[2] = 1;
  throwsCode(() => canonicalJson(sparse), "INVALID_JSON");
});

test("UTF-8 字节序键比较", () => {
  const keys = ["b", "A", "a", "Z", "\u{1F600}", "\u4E2D"];
  assert.deepEqual([...keys].sort(compareUtf8Keys), ["A", "Z", "a", "b", "\u4E2D", "\u{1F600}"]);
});

test("严格 JSON 解析：拒绝重复对象键", () => {
  assert.deepEqual(parseStrictJson('{"a":1,"b":[2,{"c":null}]}'), { a: 1, b: [2, { c: null }] });
  throwsCode(() => parseStrictJson('{"a":1,"a":2}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":{"b":1,"b":2}}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":1,"a":2,"a":3}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson("{'a':1}"), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":1} trailing'), "INVALID_JSON");
  throwsCode(() => parseStrictJson(""), "INVALID_JSON");
  throwsCode(() => parseStrictJson("\uFEFF{}"), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":01}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":1e999}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":"\\u00ZZ"}'), "INVALID_JSON");
  throwsCode(() => parseStrictJson('{"a":}'), "INVALID_JSON");
});

test("严格 JSON 解析：深度限制", () => {
  const deep = JSON.stringify({ child: JSON.parse('{"x":'.repeat(40) + "1" + "}".repeat(40)) });
  throwsCode(() => parseStrictJson(deep), "INVALID_JSON");
  assert.deepEqual(parseStrictJson(deep, { maxDepth: 64 }), JSON.parse(deep));
});

test("可移植内容摘要：排除本机字段，内容差异可检出", () => {
  const content: DictionaryVersionContent = {
    name: "订单服务",
    description: "",
    enabled: true,
    kind: "plain",
    entries: { baseUrl: { type: "string", value: "https://example" } },
  };
  const hash = portableContentHash(content);
  assert.equal(hash, portableContentHash({ ...content }));
  // 键顺序不影响规范化摘要。
  assert.equal(hash, portableContentHash({ ...content, entries: Object.fromEntries(Object.entries(content.entries).reverse()) }));
  assert.equal(createHash("sha256").update(canonicalJson({ name: content.name, description: content.description, enabled: content.enabled, kind: content.kind, entries: content.entries }), "utf8").digest("hex"), hash);
  assert.notEqual(hash, portableContentHash({ ...content, name: "其他" }));
  assert.notEqual(hash, portableContentHash({ ...content, enabled: false }));
  assert.notEqual(hash, portableContentHash({ ...content, entries: { baseUrl: { type: "string", value: "https://other" } } }));
  assert.notEqual(hash, portableContentHash({ ...content, kind: "encrypted" }));
  assert.equal(sameVersionContent(content, { ...content }), true);
  assert.equal(sameVersionContent(content, { ...content, description: "变更" }), false);
});

test("错误码：禁用、类型不匹配、缺失与键缺失", () => {
  assert.equal(dictionaryUnavailableError("disabled").code, "DICTIONARY_DISABLED");
  assert.equal(dictionaryUnavailableError("kind").code, "DICTIONARY_KIND_MISMATCH");
  assert.equal(dictionaryUnavailableError("missing").code, "DICTIONARY_NOT_FOUND");
  assert.equal(dictionaryKeyMissingError("baseUrl").code, "DICTIONARY_KEY_MISSING");
});
