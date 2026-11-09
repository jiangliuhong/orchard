import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecretsCli } from "../src/secrets/cli.js";
import type { TestContext } from "node:test";

interface RecordedRequest { path: string; init?: RequestInit }

function cliHarness(t: import("node:test").TestContext, status: unknown, responses: (path: string, body: Record<string, unknown>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "orchard-secret-cli-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const requests: RecordedRequest[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, init });
    if (path.endsWith("/secrets/status")) return status;
    return responses(path, body);
  };
  const outputs: unknown[] = [];
  const output = (value: unknown) => outputs.push(value);
  return { root, requests, outputs, run: (args: string[]) => runSecretsCli(args, { dataDir: root, request, output }) };
}

test("密钥 CLI：status、init、activate 走已认证本地 API 且不打印密钥", async (t: TestContext) => {
  const { requests, outputs, run } = cliHarness(t, { configured: true, generation: 2, activeKeyId: "a", readOnly: false, keys: [{ keyId: "a", createdAt: 1, active: true }], encryptedDictionaries: 0, missingKeyIds: [] },
    (path, body) => {
      if (path.endsWith("/secrets/keys")) return { keyId: body.keyId, generation: body.generation };
      if (path.endsWith("/secrets/active-key")) return { generation: 3, activeKeyId: body.keyId };
      return {};
    });
  await run(["keyring", "status"]);
  assert.deepEqual(outputs[0], { configured: true, generation: 2, activeKeyId: "a", readOnly: false, keys: [{ keyId: "a", createdAt: 1, active: true }], encryptedDictionaries: 0, missingKeyIds: [] });
  await run(["keyring", "init"]);
  const init = requests.find(request => request.path.endsWith("/secrets/keys"))!;
  assert.equal(init.init?.method, "POST");
  const initBody = JSON.parse(String(init.init?.body)) as Record<string, unknown>;
  assert.equal(initBody.expectedGeneration, 2);
  assert.equal(typeof initBody.requestId, "string");
  assert.equal(JSON.stringify(outputs).includes("material"), false);
  await run(["keyring", "activate", "--key-id", "a"]);
  const activate = requests.find(request => request.path.endsWith("/secrets/active-key"))!;
  assert.equal(activate.init?.method, "PUT");
  assert.equal(JSON.parse(String(activate.init?.body)).keyId, "a");
  // 未知子命令与缺参数失败。
  await assert.rejects(() => run(["keyring", "unknown"]), /未知密钥子命令/);
  await assert.rejects(() => run(["keyring", "activate"]), /--key-id/);
});

test("密钥 CLI：import 读取备份文件、export 落盘 0600 且正文不进输出", async (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "orchard-secret-cli-file-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const backupPath = join(root, "backup.json");
  const backupBody = JSON.stringify({ formatVersion: 1, activeKeyId: "only", keys: [{ keyId: "only", algorithm: "aes-256-gcm", material: Buffer.alloc(32).toString("base64") }] });
  writeFileSync(backupPath, backupBody, { mode: 0o600 });
  const requests: RecordedRequest[] = [];
  const request = async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, init });
    if (path.endsWith("/secrets/status")) return { configured: false, generation: 0, activeKeyId: null, readOnly: false, keys: [], encryptedDictionaries: 0, missingKeyIds: [] };
    if (path.endsWith("/secrets/import")) return { generation: 1, added: 1, unchanged: 0 };
    if (path.endsWith("/secrets/export")) return JSON.parse(backupBody);
    return {};
  };
  const outputs: unknown[] = [];
  const output = (value: unknown) => outputs.push(value);
  const run = (args: string[]) => runSecretsCli(args, { dataDir: root, request, output });
  // 导入：文件内容作为 backupText，活动密钥建议透传。
  await run(["keyring", "import", "--file", backupPath, "--active-key-id", "only"]);
  const importRequest = requests.find(request => request.path.endsWith("/secrets/import"))!;
  const importBody = JSON.parse(String(importRequest.init?.body)) as Record<string, unknown>;
  assert.equal(importBody.backupText, backupBody);
  assert.equal(importBody.activeKeyId, "only");
  assert.equal(importBody.expectedGeneration, 0);
  // 缺失文件拒绝。
  await assert.rejects(() => run(["keyring", "import", "--file", join(root, "missing.json")]), /备份文件不存在/);
  // 导出：0600 落盘，输出仅路径与 keyId，不含材料。
  const target = join(root, "out.json");
  await run(["keyring", "export", "--file", target, "--key-id", "only"]);
  assert.equal(existsSync(target), true);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), JSON.parse(backupBody));
  const exportOutput = outputs.find(value => typeof value === "object" && value !== null && "path" in (value as object)) as { path: string; keyIds: string[] };
  assert.deepEqual(exportOutput.keyIds, ["only"]);
  assert.equal(JSON.stringify(outputs).includes("AAAAAAAA"), false);
  // 导出不覆盖已有文件（wx 标志）。
  await assert.rejects(() => run(["keyring", "export", "--file", target]));
  chmodSync(target, 0o600);
});
