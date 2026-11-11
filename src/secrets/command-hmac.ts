import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError, check } from "../domain/errors.js";
import { canonicalJson } from "../dictionaries/canonical.js";
import { durable } from "../migrations/journal.js";
import { checkSecretPath } from "./files.js";
import type { Store } from "../persistence/store.js";
import type { KeyringStore } from "./keyring.js";

/**
 * 敏感命令回执与本机 HMAC 密钥（设计 §7.4）。
 * 加密字典写请求不能复用普通 SHA-256 回执协议；本入口计算
 * HMAC-SHA-256(localKey, canonical({ protocol, scope, request })) 后复用 Store
 * 的同步事务与 (scope, request_id) 唯一性。本机 HMAC 密钥为独立随机 32 字节文件
 * <data-dir>/secrets/command-hmac.key；已有敏感记录而文件丢失或损坏时返回
 * SECRET_RECEIPT_KEY_MISSING，不生成替代密钥。
 */

export const SENSITIVE_COMMAND_PROTOCOL = "orchard-sensitive-command-v1";
const HMAC_KEY_BYTES = 32;

export function sensitiveRequestDigest(localKey: Buffer, scope: string, request: unknown): string {
  return createHmac("sha256", localKey).update(canonicalJson({ protocol: SENSITIVE_COMMAND_PROTOCOL, scope, request }), "utf8").digest("hex");
}

export class CommandHmac {
  readonly path: string;

  constructor(readonly store: Store, dataDir: string, private readonly keyring: KeyringStore) {
    this.path = join(dataDir, "secrets", "command-hmac.key");
  }

  /** 数据库敏感 scope 回执或密钥环本机操作记录是否已存在。 */
  hasSensitiveHistory(): boolean {
    const receipt = this.store.one("SELECT 1 AS present FROM command_receipts WHERE scope LIKE 'secrets:%' OR scope LIKE 'dictionary-secret:%' OR scope LIKE 'script-test-v2:%' OR scope LIKE 'private-run:%' OR scope LIKE 'private-draft-run:%' LIMIT 1");
    if (receipt) return true;
    const keyring = this.keyring.load();
    return !!keyring && keyring.operations.length > 0;
  }

  /**
   * 读取本机 HMAC 密钥；首次敏感写入前在调用方的 withWrite 内原子创建。
   * 只有无敏感 scope 回执且密钥环没有本机操作记录时才允许首次创建。
   */
  ensure(): Buffer {
    checkSecretPath(this.path, "SECRET_RECEIPT_KEY_MISSING");
    const info = lstatSync(this.path, { throwIfNoEntry: false });
    if (!info) {
      if (this.hasSensitiveHistory()) throw new AppError("SECRET_RECEIPT_KEY_MISSING", "本机回执密钥缺失，敏感写入与重试被阻止", 422);
      const key = randomBytes(HMAC_KEY_BYTES);
      durable(this.path, key);
      return key;
    }
    check(info.isFile() && !info.isSymbolicLink() && info.size === HMAC_KEY_BYTES, "SECRET_RECEIPT_KEY_MISSING", "本机回执密钥缺失或损坏", 422);
    const key = readFileSync(this.path);
    check(key.byteLength === HMAC_KEY_BYTES, "SECRET_RECEIPT_KEY_MISSING", "本机回执密钥缺失或损坏", 422);
    return key;
  }
}
