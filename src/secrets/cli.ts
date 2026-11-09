import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseKeyringBackup, serializeKeyringBackup } from "./backup.js";

/**
 * 字典密钥 CLI（设计 §6.3）：通过已认证本地 API 调用同一密钥服务，
 * 不绕过正在运行的服务直接写密钥文件；密钥值不作为命令行参数、不打印到 stdout。
 */

export const secretsHelp = `orchard secrets keyring status
orchard secrets keyring init [--activate]
orchard secrets keyring import --file <backup.json> [--active-key-id <id>]
orchard secrets keyring export --file <backup.json> [--key-id <id>...]
orchard secrets keyring verify [--dictionary <id>...]
orchard secrets keyring activate --key-id <id>`;

interface CliOptions {
  dataDir: string;
  request: (path: string, init?: RequestInit) => Promise<unknown>;
  output: (value: unknown) => void;
}

function fail(message: string): never { throw Object.assign(new Error(message), { code: "SECRET_CLI_INVALID_INPUT" }); }

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function values(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let at = args.indexOf(name); at >= 0; at = args.indexOf(name, at + 1)) {
    const value = args[at + 1];
    if (value === undefined) fail(`--${name.replace(/^--/, "")} 缺少参数值`);
    result.push(value);
  }
  return result;
}

async function expectGeneration(options: CliOptions): Promise<number> {
  const status = await options.request("/api/secrets/status") as { generation: number };
  return status.generation;
}

export async function runSecretsCli(args: string[], options: CliOptions): Promise<void> {
  const [group, command = "status"] = args;
  if (group !== "keyring") return fail("未知密钥子命令，使用 orchard secrets keyring --help 查看");
  if (args.includes("--help")) return options.output({ help: secretsHelp });
  const rest = args.slice(args.indexOf(command) + 1);
  switch (command) {
    case "status": {
      const status = await options.request("/api/secrets/status");
      return options.output(status);
    }
    case "init": {
      const expectedGeneration = await expectGeneration(options);
      const result = await options.request("/api/secrets/keys", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), expectedGeneration, makeActive: args.includes("--activate") }),
      });
      return options.output(result);
    }
    case "import": {
      const file = flag(rest, "--file");
      if (!file) return fail("import 需要 --file 指向备份文件");
      const backupPath = resolve(file);
      if (!existsSync(backupPath)) return fail("备份文件不存在");
      const backupText = readRegularText(backupPath);
      const activeKeyId = flag(rest, "--active-key-id");
      const expectedGeneration = await expectGeneration(options);
      const result = await options.request("/api/secrets/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), expectedGeneration, backupText, ...(activeKeyId ? { activeKeyId } : {}) }),
      });
      return options.output(result);
    }
    case "export": {
      const file = flag(rest, "--file");
      if (!file) return fail("export 需要 --file 指定备份输出路径");
      const target = resolve(file);
      const keyIds = values(rest, "--key-id");
      const expectedGeneration = await expectGeneration(options);
      const backup = await options.request("/api/secrets/export", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration, ...(keyIds.length ? { keyIds } : {}) }),
      });
      const parsed = parseKeyringBackup(JSON.stringify(backup));
      // API 返回备份 JSON 正文；只写 0600 文件，不打印材料、不覆盖已有文件。
      writeFileSync(target, serializeKeyringBackup(parsed), { mode: 0o600, flag: "wx" });
      chmodSync(target, 0o600);
      return options.output({ path: target, keyIds: parsed.keys.map(key => key.keyId) });
    }
    case "verify": {
      const dictionaryIds = values(rest, "--dictionary");
      const expectedGeneration = await expectGeneration(options);
      const result = await options.request("/api/secrets/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedGeneration, ...(dictionaryIds.length ? { dictionaryIds } : {}) }),
      });
      return options.output(result);
    }
    case "activate": {
      const keyId = flag(rest, "--key-id");
      if (!keyId) return fail("activate 需要 --key-id");
      const expectedGeneration = await expectGeneration(options);
      const result = await options.request("/api/secrets/active-key", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: randomUUID(), expectedGeneration, keyId }),
      });
      return options.output(result);
    }
    default:
      return fail(`未知密钥子命令: ${command}`);
  }
}

function readRegularText(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) return fail("备份文件必须是不超过 1 MiB 的普通文件");
  return readFileSync(path, "utf8");
}
