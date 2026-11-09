import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConfigWriteCoordinator, configCoordinator } from "../src/config-git/coordinator.js";
import { setup } from "./helpers.js";
import type { PreparedReference } from "../src/persistence/store.js";
import type { TestContext } from "node:test";

const throwsCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    return;
  }
  assert.fail(`预期抛出 ${code}`);
};

test("withAdmission 接受同步回调且不递增配置 generation", () => {
  const coordinator = new ConfigWriteCoordinator();
  assert.equal(coordinator.withAdmission(() => 42), 42);
  assert.equal(coordinator.generation, 0);
  // 与活动共存：现有 queued/running activity 不阻止入队保护。
  coordinator.withActivity("run:execute", () => {
    assert.equal(coordinator.withAdmission(() => "admitted"), "admitted");
  });
  assert.equal(coordinator.generation, 0);
});

test("withAdmission 与 reader、writer、另一入队保护和恢复 exclusive 互斥", () => {
  const coordinator = new ConfigWriteCoordinator();
  throwsCode(() => coordinator.withRead(() => coordinator.withAdmission(() => 1)), "CONFIG_BUSY");
  throwsCode(() => coordinator.withWrite(() => coordinator.withAdmission(() => 1)), "CONFIG_BUSY");
  coordinator.withAdmission(() => throwsCode(() => coordinator.withAdmission(() => 1), "CONFIG_BUSY"));
  throwsCode(() => coordinator.withExclusive(() => coordinator.withAdmission(() => 1)), "CONFIG_BUSY");
  // 排他期间直接申请入队保护同样拒绝。
  coordinator.withExclusive(() => throwsCode(() => coordinator.withAdmission(() => 1), "CONFIG_BUSY"));
  // 维护态拒绝入队保护。
  coordinator.setMaintenance("恢复未完成");
  throwsCode(() => coordinator.withAdmission(() => 1), "RECOVERY_REQUIRED");
  coordinator.setMaintenance(null);
});

test("withAdmission 内允许登记长期 activity，入队保护期间拒绝写入与快照读取", () => {
  const coordinator = new ConfigWriteCoordinator();
  coordinator.withAdmission(() => {
    // 模拟提交后、释放入队保护前登记持久任务 activity（由队列稍后释放）。
    const releaseTask = coordinator.beginActivity("run:queued");
    throwsCode(() => coordinator.withWrite(() => 1), "CONFIG_BUSY");
    throwsCode(() => coordinator.withRead(() => 1), "CONFIG_BUSY");
    throwsCode(() => coordinator.withExclusive(() => 1), "CONFIG_BUSY");
    releaseTask();
  });
  // 释放保护后可再次入队；长期 activity 与入队保护共存。
  const releaseTask = coordinator.beginActivity("run:queued");
  assert.equal(coordinator.withAdmission(() => "next"), "next");
  throwsCode(() => coordinator.withRead(() => 1), "CONFIG_BUSY");
  releaseTask();
  assert.equal(coordinator.activeCount, 0);
  assert.equal(coordinator.generation, 0);
});

test("withAdmission 回调返回 Promise 视为编程错误", async () => {
  const coordinator = new ConfigWriteCoordinator();
  assert.throws(() => coordinator.withAdmission(() => Promise.resolve(1)), /编程错误/);
  assert.throws(() => coordinator.withAdmission(() => ({ then: () => undefined })), /编程错误/);
  // 保护已释放，后续入队不受影响。
  assert.equal(coordinator.withAdmission(() => "ok"), "ok");
  await Promise.resolve();
});

test("withAdmission 保护释放后恢复原有读写语义", () => {
  const coordinator = new ConfigWriteCoordinator();
  coordinator.withAdmission(() => undefined);
  assert.equal(coordinator.withWrite(() => "write"), "write");
  assert.equal(coordinator.generation, 1);
  assert.equal(coordinator.withRead(() => "read"), "read");
  coordinator.withExclusive(() => "exclusive");
  assert.equal(coordinator.withAdmission(() => "again"), "again");
});

test("prepareReference 与 attachPreparedReference 覆盖 inline 与大值安装", (t: TestContext) => {
  const { store, root } = setup(t);
  t.after(() => store.close());
  const small = { payload: { value: "配置" } };
  const preparedInline = store.prepareReference(small);
  assert.equal(preparedInline.kind, "inline");
  assert.deepEqual(JSON.parse(store.attachPreparedReference(preparedInline)), { inline: small });
  assert.deepEqual(store.dereference(store.attachPreparedReference(preparedInline)), small);

  const large = { data: "x".repeat(40 * 1024) };
  const before = store.one("SELECT count(*) AS n FROM artifacts")!.n as number;
  const prepared = store.prepareReference(large);
  assert.equal(prepared.kind, "blob");
  // 准备阶段只安装文件，不登记 artifacts 行；失败不会残留业务引用。
  assert.equal(store.one("SELECT count(*) AS n FROM artifacts")!.n, before);
  const descriptor = prepared as Extract<PreparedReference, { kind: "blob" }>;
  assert.equal(descriptor.relativePath, `artifacts/blobs/${descriptor.sha256}.json`);
  assert.equal(descriptor.byteSize, Buffer.byteLength(JSON.stringify(large)));
  const installed = readFileSync(join(root, descriptor.relativePath));
  assert.equal(installed.byteLength, descriptor.byteSize);
  const reference = store.attachPreparedReference(prepared);
  assert.deepEqual(JSON.parse(reference), { artifactId: descriptor.artifactId });
  assert.equal(store.one("SELECT count(*) AS n FROM artifacts")!.n, before + 1);
  assert.deepEqual(store.dereference(reference), large);
  // 同一描述重复登记幂等，读取保持一致。
  assert.equal(store.attachPreparedReference(prepared), reference);
  assert.deepEqual(store.dereference(reference), large);
});

test("prepareReference 复用已有文件并校验字节数与摘要", (t: TestContext) => {
  const { store, root } = setup(t);
  t.after(() => store.close());
  const value = { data: "y".repeat(40 * 1024) };
  const first = store.prepareReference(value) as Extract<PreparedReference, { kind: "blob" }>;
  const second = store.prepareReference(value) as Extract<PreparedReference, { kind: "blob" }>;
  assert.equal(first.relativePath, second.relativePath);
  // 内容寻址路径内容保持一致。
  assert.equal(readFileSync(join(root, first.relativePath)).byteLength, first.byteSize);
  // 文件被破坏后重新准备必须拒绝复用。
  const target = join(root, first.relativePath);
  const original = readFileSync(target);
  const corrupted = Buffer.from(original);
  corrupted[0] = corrupted[0]! ^ 0xff;
  writeFileSync(target, corrupted);
  throwsCode(() => store.prepareReference(value), "ARTIFACT_MISMATCH");
  // 恢复文件后再次准备成功。
  writeFileSync(target, original);
  assert.equal(store.prepareReference(value).kind, "blob");
});

test("attachPreparedReference 拒绝篡改的描述与缺失文件", (t: TestContext) => {
  const { store, root } = setup(t);
  t.after(() => store.close());
  const value = { data: "z".repeat(40 * 1024) };
  const prepared = store.prepareReference(value) as Extract<PreparedReference, { kind: "blob" }>;
  throwsCode(() => store.attachPreparedReference({ ...prepared, byteSize: prepared.byteSize - 1 }), "ARTIFACT_MISSING");
  throwsCode(() => store.attachPreparedReference({ ...prepared, sha256: "f".repeat(64) }), "ARTIFACT_MISMATCH");
  throwsCode(() => store.attachPreparedReference({ ...prepared, relativePath: "staging/evil.json" }), "ARTIFACT_MISMATCH");
  throwsCode(() => store.attachPreparedReference({ kind: "inline" }), "ARTIFACT_MISMATCH");
  throwsCode(() => store.attachPreparedReference(null), "ARTIFACT_MISMATCH");
  // 16 MiB 上限与大小合法性。
  throwsCode(() => store.attachPreparedReference({ ...prepared, byteSize: 20 * 1024 * 1024 }), "ARTIFACT_MISMATCH");
  // 删除已安装文件后 attach 拒绝，不登记 artifacts 行。
  unlinkSync(join(root, prepared.relativePath));
  const before = store.one("SELECT count(*) AS n FROM artifacts")!.n as number;
  throwsCode(() => store.attachPreparedReference(prepared), "ARTIFACT_MISSING");
  assert.equal(store.one("SELECT count(*) AS n FROM artifacts")!.n, before);
});

test("prepareReference 拒绝超过 16 MiB 的输入", (t: TestContext) => {
  const { store } = setup(t);
  t.after(() => store.close());
  throwsCode(() => store.prepareReference({ data: "x".repeat(17 * 1024 * 1024) }), "OUTPUT_LIMIT");
  // inline 阈值边界：32 KiB 以内 inline，超过走安装。
  assert.equal(store.prepareReference({ data: "x".repeat(32768 - 20) }).kind, "inline");
  assert.equal(store.prepareReference({ data: "x".repeat(32768) }).kind, "blob");
});

test("共享协调器：Store 入队保护与配置写入互斥", (t: TestContext) => {
  const { store } = setup(t);
  t.after(() => store.close());
  const coordinator = configCoordinator(store);
  coordinator.withWrite(() => throwsCode(() => coordinator.withAdmission(() => 1), "CONFIG_BUSY"));
  coordinator.withAdmission(() => throwsCode(() => coordinator.withWrite(() => 1), "CONFIG_BUSY"));
  assert.equal(coordinator.withAdmission(() => "granted"), "granted");
});
