import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/domain/errors.js";
import { multiCapabilityBlockers, REQUIRED_MULTI_CAPABILITIES, validateSessionReference, type ProviderCapabilityReport, type ReferenceValidator } from "../src/agent/provider-contract.js";

const adapter: ReferenceValidator = {
  providerId: "third-party-test",
  supportedVersions: [7],
  validatePayload(payload) {
    assert.deepEqual(payload, { locator: ["private", 42] });
  },
};
const reference = () => ({ providerId: adapter.providerId, version: 7, opaque: { locator: ["private", 42] } });
const errorCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("第三种 Provider 可校验自己的引用，无需添加 CLI 专有字段", () => {
  const value = reference();
  assert.equal(validateSessionReference(value, adapter), value);
});

test("引用拒绝 Provider 不匹配、未知版本和额外字段，不猜测或转换引用", () => {
  assert.throws(() => validateSessionReference({ ...reference(), providerId: "other" }, adapter), errorCode("BACKEND_PROVIDER_MISMATCH"));
  for (const version of [0, -1, 1.5, 8]) {
    assert.throws(() => validateSessionReference({ ...reference(), version }, adapter), errorCode("BACKEND_REFERENCE_VERSION_UNSUPPORTED"));
  }
  assert.throws(() => validateSessionReference({ ...reference(), token: "not-allowed" }, adapter), errorCode("BACKEND_REFERENCE_INVALID"));
});

test("payload 必须经过适配器校验", () => {
  assert.throws(() => validateSessionReference({ ...reference(), opaque: { locator: "wrong" } }, adapter), assert.AssertionError);
});

test("引用拒绝不可无损序列化的值、循环、过深和超大数据", () => {
  const cycle: unknown[] = []; cycle.push(cycle);
  const sparse = new Array(2);
  const extra = Object.assign([1], { extra: 2 });
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("不应执行 getter"); } });
  let deep: unknown = null;
  for (let i = 0; i < 40; i++) deep = { deep };
  for (const opaque of [undefined, NaN, Infinity, 1n, () => {}, Symbol(), new Date(), cycle, sparse, extra, accessor, deep, "界".repeat(24000), Array(9000).fill(null)]) {
    assert.throws(() => validateSessionReference({ ...reference(), opaque }, adapter), errorCode("BACKEND_REFERENCE_INVALID"));
  }
});

test("共享 JSON 子对象不是循环", () => {
  const shared = { value: 1 };
  const value = { ...reference(), opaque: [shared, shared] };
  assert.doesNotThrow(() => validateSessionReference(value, { ...adapter, validatePayload() {} }));
});

test("multi 门禁默认拒绝；协议声明/不支持/空证据/安装版本变化均不放行", () => {
  const report: ProviderCapabilityReport = { providerId: adapter.providerId, installedVersion: "1.0", capabilities: {} };
  assert.deepEqual(multiCapabilityBlockers(report, "1.0"), [...REQUIRED_MULTI_CAPABILITIES]);
  for (const name of REQUIRED_MULTI_CAPABILITIES) report.capabilities[name] = { status: "verified", evidence: "tests/fake-provider: passed" };
  assert.deepEqual(multiCapabilityBlockers(report, "1.0"), []);
  assert.deepEqual(multiCapabilityBlockers(report, "2.0"), ["version_mismatch"]);
  assert.deepEqual(multiCapabilityBlockers(report, ""), ["version_mismatch"]);
  report.capabilities.nativeDelete = { status: "unsupported", reason: "no verified native delete" };
  report.capabilities.hostFeedback = { status: "unverified", reason: "schema only" };
  report.capabilities.deleteStateQuery = { status: "verified", evidence: " " };
  assert.deepEqual(multiCapabilityBlockers(report, "1.0"), ["hostFeedback", "nativeDelete", "deleteStateQuery"]);
  assert.equal(REQUIRED_MULTI_CAPABILITIES.length, 9);
  assert.ok(REQUIRED_MULTI_CAPABILITIES.includes("nativeResume"));
});
