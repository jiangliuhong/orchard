import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, digest, type FileStore } from "../persistence/files.js";
import type { JsonSchema } from "../domain/types.js";
import type { WebBridgeTool } from "./catalog.js";
import type { CredentialBindings } from "./credential-inputs.js";
import { credentialHistoryInput, credentialProperties, credentialSchema } from "./credential-schema.js";
import { captureHistory, pointerPart, type HistorySources } from "./history-policy.js";

export interface BridgeExecutionRecord {
  id: string;
  application: string;
  toolId: string;
  source: "call" | "test";
  startedAt: number;
  durationMs: number;
  status: "succeeded" | "failed";
  args: unknown;
  environmentId?: string;
  errorCode?: string;
  redacted: boolean;
  formatVersion?: 2;
  argSources?: HistorySources;
  credentialSources?: HistorySources;
  credentialValues?: Record<string, string>;
  schemas?: { parameters: JsonSchema; credentials?: JsonSchema };
  toolHash?: string;
  definitionChanged?: boolean;
  legacy?: boolean;
}
export const bridgeToolHash = (tool: WebBridgeTool) => digest(canonicalJson(tool));
function captureCredentials(values: unknown, schema: JsonSchema, sources: HistorySources = {}) {
  const result = captureHistory(values, schema, sources);
  if (result.sources[""]?.source === "omitted") {
    const reason = result.sources[""];
    delete result.sources[""];
    for (const name of Object.keys(values && typeof values === "object" ? values : {})) result.sources[`/${pointerPart(name)}`] ??= reason;
  }
  return result;
}
type Input = Pick<BridgeExecutionRecord, "application" | "toolId" | "source" | "startedAt" | "durationMs" | "status" | "args" | "environmentId" | "errorCode">;

/** Local runtime records. Only schema-permitted raw values and unresolved references are persisted. */
export class BridgeExecutionHistory {
  private items: BridgeExecutionRecord[];
  constructor(private files?: FileStore) {
    const path = files?.path("runtime/bridge-history.json");
    this.items = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  }
  private commit(items: BridgeExecutionRecord[]) {
    if (this.files) {
      const path = this.files.path("runtime/bridge-history.json"), temporary = this.files.path(`runtime/bridge-history-${randomUUID()}.tmp`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(items), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    }
    this.items = items;
  }
  /** Irreversibly apply tighter current policy to stored records, not just their display DTOs. */
  restrict(tool: WebBridgeTool) {
    const items = this.items.map(record => {
      if (record.application !== tool.application || record.toolId !== tool.toolId) return record;
      const legacy = record.formatVersion !== 2 || record.legacy;
      const original = captureHistory(record.args, record.schemas?.parameters ?? true, record.argSources, legacy);
      const args = captureHistory(original.value, tool.parameters, original.sources);
      const execution = tool.execution?.transport === "browser" ? tool.execution : undefined;
      const credentials = captureCredentials(record.credentialValues ?? {}, record.schemas?.credentials ?? true, record.credentialSources);
      const current = captureCredentials(credentials.value, execution ? credentialSchema(execution) : true, credentials.sources);
      if (legacy && execution) for (const name of Object.keys(credentialProperties(execution))) {
        const path = `/${pointerPart(name)}`;
        if (!Object.hasOwn(current.sources, path)) current.sources[path] = { source: "omitted", reason: "legacy-unknown" };
      }
      return { ...record, args: args.value ?? null, argSources: args.sources, credentialValues: current.value as Record<string, string> ?? {}, credentialSources: current.sources, legacy: !!legacy, redacted: [...Object.values(args.sources), ...Object.values(current.sources)].some(source => source.source === "omitted") };
    });
    if (JSON.stringify(items) !== JSON.stringify(this.items)) this.commit(items);
  }
  list(application: string, toolId: string, tool?: WebBridgeTool) {
    if (tool) this.restrict(tool);
    return structuredClone(this.items.filter(item => item.application === application && item.toolId === toolId).slice(0, 100).map(record => ({ ...record, definitionChanged: !!tool && !!record.toolHash && record.toolHash !== bridgeToolHash(tool), legacy: record.formatVersion !== 2 || record.legacy })));
  }
  add(input: Input, context: { tool?: WebBridgeTool; bindings?: CredentialBindings; omitArgs?: boolean } = {}) {
    const tool = context.tool;
    const schemas = { parameters: tool?.parameters ?? { "x-history": { record: false } }, credentials: tool?.execution?.transport === "browser" ? credentialSchema(tool.execution) : undefined };
    // Keep the root omission authoritative when current tool policy is reapplied.
    const args = captureHistory(context.omitArgs ? null : input.args, schemas.parameters,
      context.omitArgs ? { "": { source: "omitted", reason: "schema-policy" } } : {});
    const credentials = tool?.execution?.transport === "browser" ? credentialHistoryInput(tool.execution, context.bindings ?? {}) : { values: {}, sources: {} };
    const captured = captureCredentials(credentials.values, schemas.credentials ?? true, credentials.sources);
    const record: BridgeExecutionRecord = {
      ...input, args: args.value ?? null, id: randomUUID(), formatVersion: 2, schemas: structuredClone(schemas),
      argSources: args.sources, credentialSources: captured.sources, credentialValues: captured.value as Record<string, string> ?? {},
      toolHash: tool ? bridgeToolHash(tool) : undefined,
      redacted: [...Object.values(args.sources), ...Object.values(captured.sources)].some(source => source.source === "omitted"),
    };
    this.commit([record, ...this.items].slice(0, 500));
    return structuredClone(record);
  }
}
