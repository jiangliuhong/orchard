import { configCoordinator } from "../config-git/coordinator.js";
import { check } from "../domain/errors.js";
import { canonicalJson, digest } from "../persistence/files.js";
import type { Store } from "../persistence/store.js";
import { markWorkspaceDirty, requireWorkspaceSchema } from "../agent/workspace-state.js";
import type { BridgeConfigurationStorage } from "./config.js";
import { validateBridgeConfigV1 } from "./config-validation.js";

/** Legacy validation/presentation requires runtime booleans. They are synthesized,
 * never made authoritative DB configuration or included in its revision/hash. */
export function bridgeRuntimeView(text: string): string {
  const value = JSON.parse(text);
  check(value && typeof value === "object" && !Array.isArray(value) && value.environments && typeof value.environments === "object", "BRIDGE_CONFIG_INVALID", "浏览器数据库配置无效", 503);
  for (const environments of Object.values(value.environments)) {
    check(Array.isArray(environments), "BRIDGE_CONFIG_INVALID", "浏览器环境配置无效", 503);
    for (const environment of environments) { environment.bound = false; environment.tabAvailable = false; }
  }
  return JSON.stringify(value);
}
export function bridgeDeclaration(text: string): string {
  const value = validateBridgeConfigV1(text);
  const clone = structuredClone(value) as unknown as { environments: Record<string, Record<string, unknown>[]> };
  for (const environments of Object.values(clone.environments)) for (const environment of environments) { delete environment.bound; delete environment.tabAvailable; }
  return canonicalJson(clone);
}

/** Explicit DB backend: never reads/writes config/web-bridge.json or installs a
 * schema on construction. The caller must have completed the reviewed migration. */
export class DatabaseBridgeConfiguration implements BridgeConfigurationStorage {
  revision = 0;
  constructor(private readonly store: Store) { requireWorkspaceSchema(store); }
  read(): string {
    const row = this.store.one<{ revision: number; config_json: string; content_hash: string }>("SELECT revision,config_json,content_hash FROM bridge_configuration WHERE id='current'");
    check(row && digest(row.config_json) === row.content_hash, "BRIDGE_CONFIG_INVALID", "浏览器数据库配置缺失或摘要不一致", 503);
    const view = bridgeRuntimeView(row.config_json); validateBridgeConfigV1(view);
    this.revision = row.revision; return view;
  }
  write(text: string): void {
    const declaration = bridgeDeclaration(text), expected = this.revision, contentHash = digest(declaration);
    // Connection/profile runtime flags are not definition writes. A true no-op
    // must remain usable under a shared model read lease, without acquiring a
    // writer or advancing either configuration generation.
    const observed = this.store.one<{ revision: number; content_hash: string }>("SELECT revision,content_hash FROM bridge_configuration WHERE id='current'");
    check(observed?.revision === expected, "REVISION_CONFLICT", "浏览器配置已变化，请刷新后重试", 409);
    if (observed.content_hash === contentHash) return;
    const revision = configCoordinator(this.store).withWrite(() => this.store.transaction(() => {
      const current = this.store.one<{ revision: number; content_hash: string }>("SELECT revision,content_hash FROM bridge_configuration WHERE id='current'");
      check(current?.revision === expected, "REVISION_CONFLICT", "浏览器配置已变化，请刷新后重试", 409);
      if (current.content_hash === contentHash) return expected;
      const changed = this.store.exec("UPDATE bridge_configuration SET revision=revision+1,config_json=?,content_hash=?,updated_at=? WHERE id='current' AND revision=?", declaration, contentHash, Date.now(), expected);
      check(Number(changed.changes) === 1, "REVISION_CONFLICT", "浏览器配置已变化，请刷新后重试", 409);
      markWorkspaceDirty(this.store); return expected + 1;
    }));
    this.revision = revision;
  }
}
