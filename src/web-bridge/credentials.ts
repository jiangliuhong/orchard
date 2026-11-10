import { AppError, check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import type { SecretsService } from "../secrets/service.js";
import { decryptValue } from "../secrets/aead.js";
import type { DictionaryEntries } from "../dictionaries/model.js";
import type { CredentialResolver } from "./execution.js";

/** Internal-only resolver. Never expose plaintext through a route or tool snapshot. */
export function dictionaryCredentials(store: Store, secrets: SecretsService): CredentialResolver {
  return (dictionaryId, key) => {
    try {
      const row = store.one<{ kind: string; enabled: number; entries_json: string }>(
        `SELECT d.kind, v.enabled, v.entries_json FROM dictionaries d
         JOIN dictionary_versions v ON v.id=d.current_version_id AND v.dictionary_id=d.id WHERE d.id=?`, dictionaryId,
      );
      check(row && (row.kind === "plain" || row.kind === "encrypted") && row.enabled === 1, "CREDENTIAL_UNAVAILABLE", "凭据字典不存在或已停用");
      const entries = JSON.parse(row.entries_json) as DictionaryEntries;
      check(Object.hasOwn(entries, key), "CREDENTIAL_UNAVAILABLE", "凭据引用不存在");
      const entry = entries[key];
      if (row.kind === "plain") {
        check(entry.type === "string" && "value" in entry && typeof entry.value === "string", "CREDENTIAL_UNAVAILABLE", "凭据必须引用字符串类型的键");
        return entry.value;
      }
      check("encryptedValue" in entry, "CREDENTIAL_UNAVAILABLE", "加密凭据格式无效");
      const envelope = entry.encryptedValue;
      const material = secrets.keyMaterials().get(envelope.keyId);
      check(material, "CREDENTIAL_UNAVAILABLE", "凭据解密密钥不可用");
      return decryptValue(material, { keyId: envelope.keyId, dictionaryId, key }, envelope);
    } catch {
      throw new AppError("CREDENTIAL_UNAVAILABLE", "凭据不可用，请检查字典、字符串键及密钥设置");
    }
  };
}
