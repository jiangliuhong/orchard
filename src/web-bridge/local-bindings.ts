import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";

export const BRIDGE_BINDINGS_PATH = "config/web-bridge-bindings.json";
export interface BindingEnvironment { id: string; key?: string; origin: string; profileId?: string; extensionId?: string }
export interface LocalBrowserBinding { environmentId: string; origin: string; profileId?: string; extensionId?: string }
export type LocalBrowserBindings = Record<string, LocalBrowserBinding>;
export const bindingKey = (application: string, environment: Pick<BindingEnvironment, "id" | "key">) => JSON.stringify([application, environment.key ?? environment.id]);
export function validateEnvironmentKey(key: unknown): asserts key is string {
  check(typeof key === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(key), "INVALID_ENVIRONMENT_KEY", "环境标识须为 1–100 位字母、数字、点、下划线或短横线，并以字母或数字开头", 422);
}
export function readBrowserBindings(root: string): LocalBrowserBindings {
  const path = join(root, BRIDGE_BINDINGS_PATH);
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  check(value && typeof value === "object" && !Array.isArray(value), "LOCAL_BINDING_INVALID", "本机浏览器绑定文件无效", 422);
  for (const [key, binding] of Object.entries(value) as [string, LocalBrowserBinding][]) {
    let identity: unknown;
    try { identity = JSON.parse(key); } catch { /* Report invalid keys with the same structured error. */ }
    check(Array.isArray(identity) && identity.length === 2 && identity.every(part => typeof part === "string" && part.length > 0), "LOCAL_BINDING_INVALID", "本机浏览器绑定标识无效", 422);
    check(binding && typeof binding === "object" && !Array.isArray(binding) && typeof binding.environmentId === "string" && typeof binding.origin === "string" && [binding.profileId, binding.extensionId].every(v => v === undefined || typeof v === "string"), "LOCAL_BINDING_INVALID", "本机浏览器绑定无效", 422);
  }
  return value;
}
/** A stable UUID also preserves a binding when a synced environment is renamed. */
export function browserBinding(bindings: LocalBrowserBindings, application: string, environment: BindingEnvironment): LocalBrowserBinding | undefined {
  const key = bindingKey(application, environment);
  const entry = (Object.hasOwn(bindings, key) ? bindings[key] : undefined) ?? Object.entries(bindings).find(([storedKey, value]) => JSON.parse(storedKey)[0] === application && value.environmentId === environment.id)?.[1];
  // An origin change requires an explicit local selection before reusing an account.
  return entry?.origin === environment.origin ? entry : undefined;
}
export function setBrowserBinding(bindings: LocalBrowserBindings, application: string, environment: BindingEnvironment, value: Pick<LocalBrowserBinding, "profileId" | "extensionId">) {
  for (const [key, entry] of Object.entries(bindings)) if (JSON.parse(key)[0] === application && entry.environmentId === environment.id) delete bindings[key];
  bindings[bindingKey(application, environment)] = { environmentId: environment.id, origin: environment.origin, ...value };
}
/** Only migrate old locally stored values; remote localRef placeholders never enter here. */
export function migrateBrowserBindings(bindings: LocalBrowserBindings, environments: Record<string, BindingEnvironment[]>) {
  for (const [application, list] of Object.entries(environments)) for (const environment of list) {
    const exists = Object.hasOwn(bindings, bindingKey(application, environment)) || Object.entries(bindings).some(([key, entry]) => JSON.parse(key)[0] === application && entry.environmentId === environment.id);
    if (!exists && (environment.profileId || environment.extensionId)) setBrowserBinding(bindings, application, environment, { ...(environment.profileId ? { profileId: environment.profileId } : {}), ...(environment.extensionId ? { extensionId: environment.extensionId } : {}) });
  }
  return bindings;
}
export function writeBrowserBindings(root: string, bindings: LocalBrowserBindings) {
  const path = join(root, BRIDGE_BINDINGS_PATH), temp = `${path}.tmp-${randomUUID()}`;
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(temp, JSON.stringify(bindings), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, path);
}
