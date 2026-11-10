import { createHash } from "node:crypto";
import { check } from "../domain/errors.js";
import { normalizeDictionaryBindings } from "../domain/dictionaries.js";
import { validateWorkflow } from "../domain/validation.js";
import type { Store } from "../persistence/store.js";

export interface DictionaryReference {
  objectType: "workflow" | "script";
  objectId: string;
  name: string;
  versionId: string;
  state: "draft" | "current" | "history";
  nodeId?: string;
  via: "binding" | "declaration" | "script";
  scriptId?: string;
  scriptVersionId?: string;
  keys: string[];
}
export interface ReferenceScan {
  items: DictionaryReference[];
  complete: boolean;
  issues: { objectType: "workflow" | "script"; objectId: string; versionId: string; code: "REFERENCE_UNREADABLE" }[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Read definitions only. No dictionary values, source text, or parser errors enter this DTO. */
export class DictionaryReferenceScanner {
  constructor(readonly store: Store) {}
  scan(dictionaryId: string): ReferenceScan {
    const items: DictionaryReference[] = [], issues: ReferenceScan["issues"] = [];
    const issue = (base: Pick<DictionaryReference, "objectType" | "objectId" | "versionId">) => {
      if (!issues.some(i => i.objectType === base.objectType && i.objectId === base.objectId && i.versionId === base.versionId)) issues.push({ ...base, code: "REFERENCE_UNREADABLE" });
    };
    const declarations = (value: unknown, base: Omit<DictionaryReference, "keys" | "via">, via: DictionaryReference["via"]) => {
      for (const declaration of Object.values(normalizeDictionaryBindings(value) ?? {})) if (declaration.dictionaryId === dictionaryId) items.push({ ...base, via, keys: declaration.keys });
    };
    const workflow = (value: unknown, base: Omit<DictionaryReference, "keys" | "via">) => {
      // Drafts may be incomplete; retain readable references while marking their uncertainty.
      try { validateWorkflow(value); } catch { issue(base); }
      if (!object(value)) return;
      const binding = (value: unknown, nodeId?: string) => {
        if (!object(value)) return;
        if (value.source === "dictionary" && value.dictionaryId === dictionaryId && typeof value.key === "string") items.push({ ...base, ...(nodeId ? { nodeId } : {}), via: "binding", keys: [value.key] });
        if (value.source === "object" && object(value.properties)) Object.values(value.properties).forEach(v => binding(v, nodeId));
        if (value.source === "array" && Array.isArray(value.items)) value.items.forEach(v => binding(v, nodeId));
      };
      binding(value.result);
      if (Array.isArray(value.nodes)) for (const node of value.nodes) if (object(node)) {
        const nodeBase = { ...base, ...(typeof node.id === "string" ? { nodeId: node.id } : {}) };
        binding(node.input, nodeBase.nodeId);
        try {
          if (!object(node.config)) continue;
          if (node.type === "script") {
            check(typeof node.config.scriptId === "string" && typeof node.config.scriptVersionId === "string", "REFERENCE_UNREADABLE", "固定脚本版本缺失");
            const scriptId = node.config.scriptId as string, versionId = node.config.scriptVersionId as string;
            const version = this.store.scriptVersion(versionId);
            check(version.scriptId === scriptId && version.status === "published", "REFERENCE_UNREADABLE", "固定脚本版本无效");
            const definition = this.store.scriptDefinition(scriptId, versionId);
            declarations(definition.dictionaryBindings, { ...nodeBase, scriptId, scriptVersionId: versionId }, "script");
          } else declarations(node.config.dictionaryBindings, nodeBase, "declaration");
        } catch { issue(base); }
      }
    };
    for (const row of this.store.all<{ id: string; workflow_id: string; definition_json: string; current_version_id: string | null; name: string }>("SELECT v.id,v.workflow_id,v.definition_json,w.current_version_id,w.name FROM workflow_versions v JOIN workflows w ON w.id=v.workflow_id ORDER BY v.workflow_id,v.id")) {
      const base = { objectType: "workflow" as const, objectId: row.workflow_id, name: row.name, versionId: row.id, state: row.id === row.current_version_id ? "current" as const : "history" as const };
      try { workflow(JSON.parse(row.definition_json), base); } catch { issue(base); }
    }
    for (const row of this.store.all<{ id: string; workflow_id: string | null; artifact_path: string }>("SELECT id,workflow_id,artifact_path FROM drafts WHERE status<>'published' ORDER BY id")) {
      const base = { objectType: "workflow" as const, objectId: row.workflow_id ?? row.id, name: "", versionId: row.id, state: "draft" as const };
      try {
        const value: unknown = JSON.parse(this.store.files.readTree(row.artifact_path).files["workflow.json"]!);
        if (object(value) && typeof value.name === "string") base.name = value.name;
        workflow(value, base);
      } catch { issue(base); }
    }
    for (const row of this.store.all<{ id: string; script_id: string; name: string; status: string; current_published_version_id: string | null }>("SELECT v.id,v.script_id,v.status,s.name,s.current_published_version_id FROM script_versions v JOIN scripts s ON s.id=v.script_id ORDER BY v.script_id,v.id")) {
      const base = { objectType: "script" as const, objectId: row.script_id, name: row.name, versionId: row.id, state: row.status === "draft" ? "draft" as const : row.id === row.current_published_version_id ? "current" as const : "history" as const };
      try { declarations(this.store.scriptDefinition(row.script_id, row.id).dictionaryBindings, base, "declaration"); } catch { issue(base); }
    }
    const merged = new Map<string, DictionaryReference>();
    for (const item of items) {
      const identity = JSON.stringify({ ...item, keys: [] });
      const previous = merged.get(identity);
      merged.set(identity, { ...item, keys: [...new Set([...(previous?.keys ?? []), ...item.keys])].sort() });
    }
    return { items: [...merged.values()], complete: issues.length === 0, issues };
  }
  keyReferences(dictionaryId: string, keys: string[]) {
    const scan = this.scan(dictionaryId);
    return keys.map(key => {
      const refs = scan.items.filter(item => item.keys.includes(key));
      return { key, workflows: new Set(refs.filter(i => i.objectType === "workflow").map(i => i.objectId)).size, scripts: new Set(refs.filter(i => i.objectType === "script").map(i => i.objectId)).size };
    });
  }
  list(dictionaryId: string, input: { view?: "current" | "history" | "all"; limit?: number; cursor?: string } = {}) {
    const scan = this.scan(dictionaryId), view = input.view ?? "all", limit = input.limit ?? 50;
    check(["current", "history", "all"].includes(view), "INVALID_REQUEST", "引用视图无效", 400);
    check(Number.isInteger(limit) && limit >= 1 && limit <= 100, "INVALID_REQUEST", "limit 必须在 1 到 100 之间", 400);
    const items = scan.items.filter(i => view === "all" || (view === "history" ? i.state === "history" : i.state !== "history"));
    const digest = createHash("sha256").update(JSON.stringify({ items, issues: scan.issues })).digest("hex");
    let offset = 0;
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        check(cursor.digest === digest && cursor.view === view && Number.isSafeInteger(cursor.offset) && cursor.offset >= 0 && cursor.offset <= items.length, "INVALID_CURSOR", "引用已变化，请重新加载", 400);
        offset = cursor.offset;
      } catch { check(false, "INVALID_CURSOR", "引用游标无效或已过期", 400); }
    }
    return { items: items.slice(offset, offset + limit), complete: scan.complete, issues: scan.issues,
      counts: { workflows: new Set(items.filter(i => i.objectType === "workflow").map(i => i.objectId)).size, scripts: new Set(items.filter(i => i.objectType === "script").map(i => i.objectId)).size, nodes: new Set(items.filter(i => i.nodeId).map(i => `${i.objectId}:${i.versionId}:${i.nodeId}`)).size, versions: new Set(items.map(i => `${i.objectType}:${i.versionId}`)).size },
      nextCursor: offset + limit < items.length ? Buffer.from(JSON.stringify({ digest, view, offset: offset + limit })).toString("base64url") : null };
  }
}
