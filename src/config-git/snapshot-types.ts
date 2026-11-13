import type { DictionaryVersionContent } from "../dictionaries/model.js";
import type { ScriptDefinition, ScriptRuntime } from "../domain/scripts.js";
import type { SourceFiles } from "../domain/types.js";
import type { WebBridgeTool } from "../web-bridge/catalog.js";
export type SnapshotTheme = "light" | "dark" | "system";
export interface LocalRef { localRef: string }
export interface PortableProvider {
  id: string; enabled: boolean; config: { executable: LocalRef; transport: "legacy" | "native" };
  defaultModel: string; models: { id: string; name: string; source: "configured" | "discovered"; enabled: boolean; deleted: boolean }[];
  agentModelConfigs?: { id: string; name: string; description: string; modelId: string; enabled: boolean }[];
}
export interface PortableBridge {
  applications: Record<string, { id: string; name: string; enabled: boolean }>;
  // profileId/extensionId are accepted only when reading historical snapshots.
  environments: Record<string, { id: string; key?: string; origin: string; enabled: boolean; profileId?: LocalRef; extensionId?: LocalRef }[]>;
  tools: Record<string, WebBridgeTool>; enabledTools: Record<string, boolean>;
}
export interface PortableScript {
  id: string; name: string; description: string; runtime: ScriptRuntime; archived: boolean;
  currentPublishedVersionId: string | null; draft: ScriptDefinition | null;
  versions: { id: string; definition: ScriptDefinition }[];
}
export interface PortableWorkflow {
  id: string; name: string; currentPublishedVersionId: string | null;
  draft: { files: SourceFiles; baseVersionId: string | null } | null;
  versions: { id: string; files: SourceFiles }[];
}
export interface PortableDictionary { id: string; kind: "plain" | "encrypted"; currentVersionId: string; versions: ({ id: string; dictionaryId: string } & DictionaryVersionContent)[] }
export interface PortableSnapshot {
  dictionaries?: PortableDictionary[];
  general: { theme: SnapshotTheme }; providers: PortableProvider[]; webBridge: PortableBridge;
  scripts: PortableScript[]; workflows: PortableWorkflow[];
}
export type SnapshotCategory = "general" | "providers" | "webBridge" | "scripts" | "workflows" | "dictionaries";
export type SnapshotDependency = { category: "scripts"; id: string; versionId: string; digest: string } | { category: "dictionaries"; id: string; kind: "plain" | "encrypted"; keys: string[] };
export interface SnapshotObject { category: SnapshotCategory; id: string; path: string; digest: string; dependencies: SnapshotDependency[]; versions: { id: string; digest: string }[] }
export interface SnapshotManifest {
  formatVersion: 1 | 2; minOrchardVersion: string; categories: SnapshotCategory[];
  objects: SnapshotObject[]; files: { path: string; bytes: number; sha256: string }[];
}
export interface SnapshotBundle { files: SourceFiles; manifest: SnapshotManifest; digest: string; snapshot: PortableSnapshot }
