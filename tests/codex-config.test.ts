import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporary, setup } from "./helpers.js";
import { readCodexConfig, readCodexModels } from "../src/providers/codex-config.js";
import { CliProvider } from "../src/providers/registry.js";
import { codexNativeAdapter } from "../src/providers/codex-app-server.js";
import { SessionManager } from "../src/providers/session-manager.js";
import { installFixture, readLog } from "./agent-fixtures.js";

test("Codex custom catalog takes precedence over the official cache and preserves exact model IDs", context => {
  const home = temporary(context), catalog = join(home, "magpie-models.json");
  writeFileSync(join(home, "config.toml"), `openai_base_url = "http://127.0.0.1:3425/v1"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n`);
  writeFileSync(catalog, JSON.stringify({ models: [
    { slug: "group/6.1-sol", display_name: "6.1-Sol · routing group" },
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol" },
    { slug: "group/6.1-sol", display_name: "6.1-Sol · routing group" },
  ] }));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "stale-official-model" }] }));
  assert.deepEqual(readCodexModels(home).models.map(model => model.id), ["group/6.1-sol", "gpt-6.1-sol"]);
  assert.equal(readCodexConfig(home).customRoute, true);
  writeFileSync(catalog, "broken");
  const invalid = readCodexModels(home);
  assert.deepEqual(invalid.models, []);
  assert.match(invalid.warning!, /未回退/);
});

test("Codex defaults to its cache and does not expose credential-bearing parse errors", context => {
  const home = temporary(context);
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "official-model" }] }));
  assert.equal(readCodexModels(home).models[0]!.id, "official-model");
  writeFileSync(join(home, "config.toml"), 'experimental_bearer_token = "fixture-secret" invalid');
  assert.throws(() => readCodexConfig(home), error => {
    assert.equal((error as { code: string }).code, "CODEX_CONFIG_INVALID");
    assert.equal(String(error).includes("fixture-secret"), false);
    return true;
  });
});

test("Codex inherits user routing, disables configured MCP and keeps the chosen model exact", async context => {
  const { root, store, providers } = setup(context);
  const home = temporary(context), catalog = join(home, "magpie.json");
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  context.after(() => {
    store.close();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  });
  writeFileSync(join(home, "config.toml"), `
model_provider = "magpie"
model = "group/default"
model_catalog_json = ${JSON.stringify(catalog)}
[model_providers.magpie]
base_url = "http://127.0.0.1:3425/v1"
experimental_bearer_token = "fixture-secret"
[mcp_servers."local.tools"]
command = "fixture-mcp"
`);
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: "group/6.1-sol", display_name: "6.1-Sol" }] }));
  const { executable, logPath } = installFixture(context, "codex-server.mjs", "default");
  const manager = new SessionManager();
  context.after(() => manager.close());
  providers.register(new CliProvider("codex-cli", { native: codexNativeAdapter(manager, manager.limits), scheduler: manager }), executable);
  providers.update("codex-cli", { enabled: true });
  const readiness = await providers.detect("codex-cli");
  assert.match(readiness.reason!, /自定义网关/);
  assert.match(readiness.reason!, /自定义模型目录/);
  assert.deepEqual((await providers.models("codex-cli")).models.map(model => model.id), ["group/6.1-sol", "group/default"]);
  const result = await providers.run({ providerId: "codex-cli", modelId: "group/6.1-sol" }, {
    cwd: root, prompt: 'RETURN:{"answer":42}', schema: true, signal: new AbortController().signal, emit: () => {},
  });
  assert.deepEqual(result.output, { answer: 42 });
  const log = readLog(logPath);
  assert.equal(log.argv.includes("--ignore-user-config"), false);
  const starts = log.lines.map(line => JSON.parse(line)).filter(message => message.method === "thread/start");
  assert.ok(starts.some(message => message.params.model === "group/6.1-sol"));
  assert.ok(log.argv.includes("mcp_servers={}"));
  assert.ok(log.argv.includes("notify=[]"));
  assert.ok(log.argv.includes('web_search="disabled"'));
  assert.equal(JSON.stringify(log).includes("fixture-secret"), false);
  for (const feature of ["hooks", "plugins", "shell_tool", "apps", "multi_agent"]) {
    assert.ok(log.argv.includes(`features.${feature}=false`));
  }
});
