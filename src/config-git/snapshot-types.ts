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
  environments: Record<string, { id: string; origin: string; enabled: boolean; profileId?: LocalRef; extensionId?: LocalRef }[]>;
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
export interface PortableSnapshot {
  general: { theme: SnapshotTheme }; providers: PortableProvider[]; webBridge: PortableBridge;
  scripts: PortableScript[]; workflows: PortableWorkflow[];
}
export type SnapshotCategory = "general" | "providers" | "webBridge" | "scripts" | "workflows";
export interface SnapshotDependency { category: "scripts"; id: string; versionId: string; digest: string }
export interface SnapshotObject { category: SnapshotCategory; id: string; path: string; digest: string; dependencies: SnapshotDependency[]; versions: { id: string; digest: string }[] }
export interface SnapshotManifest {
  formatVersion: 1; minOrchardVersion: string; categories: SnapshotCategory[];
  objects: SnapshotObject[]; files: { path: string; bytes: number; sha256: string }[];
}
export interface SnapshotBundle { files: SourceFiles; manifest: SnapshotManifest; digest: string; snapshot: PortableSnapshot }
