import test from "node:test";
import assert from "node:assert/strict";
import { dictionaryCredentials } from "../src/web-bridge/credentials.js";
import { resolveCredentialInputs } from "../src/web-bridge/credential-inputs.js";
import { DictionaryService } from "../src/dictionaries/service.js";
import { KeyringStore, resolveKeyringPath } from "../src/secrets/keyring.js";
import { CommandHmac } from "../src/secrets/command-hmac.js";
import { SecretsService } from "../src/secrets/service.js";
import { setup } from "./helpers.js";

test("bridge resolves plain string references without a keyring and refuses other types or unavailable dictionaries", t => {
  const { store } = setup(t);
  const keyring = new KeyringStore(resolveKeyringPath(store.root));
  const secrets = new SecretsService(store, keyring, new CommandHmac(store, store.root, keyring));
  const dictionaries = new DictionaryService(store, secrets);
  const create = (enabled: boolean) => dictionaries.create({
    requestId: `plain-${enabled}`, name: `普通凭据-${enabled}`, description: "", kind: "plain", enabled,
    operations: [
      { op: "set", key: "access", type: "string", value: "plain-access" },
      { op: "set", key: "count", type: "number", value: 42 },
      { op: "set", key: "flag", type: "boolean", value: false },
      { op: "set", key: "json", type: "json", value: { token: "not-a-string" } },
    ],
  });
  const active = create(true), disabled = create(false);
  const resolve = dictionaryCredentials(store, secrets);
  assert.equal(resolve(active.dictionaryId, "access"), "plain-access");
  assert.deepEqual(resolveCredentialInputs(["ak"], {}, {
    ak: { source: "dictionary", dictionaryId: active.dictionaryId, key: "access" },
  }, resolve), { ak: "plain-access" });
  for (const [id, key] of [
    [active.dictionaryId, "count"], [active.dictionaryId, "flag"], [active.dictionaryId, "json"],
    [active.dictionaryId, "missing"], [active.dictionaryId, "toString"],
    [disabled.dictionaryId, "access"], ["missing", "access"],
  ]) assert.throws(() => resolve(id, key), { code: "CREDENTIAL_UNAVAILABLE" });
});
