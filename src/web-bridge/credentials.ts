import { AppError, check } from "../domain/errors.js";
import type { Store } from "../persistence/store.js";
import type { SecretsService } from "../secrets/service.js";
import { decryptValue, type EncryptedValue } from "../secrets/aead.js";
import type { CredentialResolver } from "./execution.js";

/** Internal-only resolver. Never expose plaintext through a route or tool snapshot. */
export function encryptedDictionaryCredentials(store: Store, secrets: SecretsService): CredentialResolver {
  return (dictionaryId, key) => {
    try {
      const row = store.one<{ kind: string; enabled: number; entries_json: string }>(
        `SELECT d.kind, v.enabled, v.entries_json FROM dictionaries d
         JOIN dictionary_versions v ON v.id=d.current_version_id AND v.dictionary_id=d.id WHERE d.id=?`, dictionaryId,
      );
      check(row?.kind === "encrypted" && row.enabled === 1, "CREDENTIAL_UNAVAILABLE", "凭据字典不存在、未加密或已停用");
      const entries = JSON.parse(row.entries_json) as Record<string, { encryptedValue: EncryptedValue }>;
      check(Object.hasOwn(entries, key), "CREDENTIAL_UNAVAILABLE", "凭据引用不存在");
      const envelope = entries[key].encryptedValue;
      const material = secrets.keyMaterials().get(envelope.keyId);
      check(material, "CREDENTIAL_UNAVAILABLE", "凭据解密密钥不可用");
      return decryptValue(material, { keyId: envelope.keyId, dictionaryId, key }, envelope);
    } catch {
      throw new AppError("CREDENTIAL_UNAVAILABLE", "加密凭据不可用，请检查字典、键名及密钥设置");
    }
  };
}
