import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";
import { AppError } from "../domain/errors.js";
import type { Model } from "../domain/types.js";

export function codexHome() { return process.env.CODEX_HOME ?? join(homedir(), ".codex"); }

// Return only fields needed by the adapter. Never expose raw config or parser errors:
// TOML errors can include source lines containing credentials.
export function readCodexConfig(home = codexHome()) {
  const path = join(home, "config.toml");
  let config: Record<string, unknown> = {};
  try { if (existsSync(path)) config = parse(readFileSync(path, "utf8")); }
  catch { throw new AppError("CODEX_CONFIG_INVALID", "无法读取 Codex 用户配置，请检查 config.toml 格式与权限"); }
  const catalog = config.model_catalog_json;
  if (catalog !== undefined && (typeof catalog !== "string" || !isAbsolute(catalog))) {
    throw new AppError("CODEX_CONFIG_INVALID", "Codex model_catalog_json 必须是模型目录的绝对路径");
  }
  const provider = typeof config.model_provider === "string" ? config.model_provider : "openai";
  return {
    home, catalogPath: catalog as string | undefined,
    configuredModel: typeof config.model === "string" ? config.model : undefined,
    provider,
    customRoute: provider !== "openai" || typeof config.openai_base_url === "string" || !!process.env.OPENAI_BASE_URL,
  };
}

export function readCodexModels(home = codexHome()): { models: Model[]; warning?: string } {
  const config = readCodexConfig(home);
  const path = config.catalogPath ?? join(home, "models_cache.json");
  const models: Model[] = [];
  try {
    const catalog: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!catalog || typeof catalog !== "object" || !Array.isArray((catalog as { models?: unknown }).models)) throw new Error("Invalid catalog");
    for (const item of (catalog as { models: unknown[] }).models) {
      if (!item || typeof item !== "object") continue;
      const model = item as { slug?: unknown; display_name?: unknown };
      if (typeof model.slug === "string" && model.slug.trim() && model.slug.length <= 200 && !/^\s*-|[\0\r\n]/.test(model.slug)) {
        models.push({ id: model.slug, name: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug, source: "discovered" });
      }
    }
  } catch {
    // An explicit custom catalog must never silently fall back to an official cache.
    return { models: [], warning: config.catalogPath ? "无法读取 Codex 自定义模型目录，请检查 model_catalog_json 指向的文件；未回退到默认缓存" : "无法读取 Codex 模型缓存，可手动添加模型 ID" };
  }
  if (config.configuredModel && !models.some(model => model.id === config.configuredModel)) {
    models.push({ id: config.configuredModel, name: config.configuredModel, source: "discovered" });
  }
  return { models: [...new Map(models.map(model => [model.id, model])).values()], ...(!models.length ? { warning: "模型目录为空，可手动添加模型 ID" } : {}) };
}
