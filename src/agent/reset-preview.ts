import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { check } from "../domain/errors.js";
import { canonical, hash, safe, scan } from "../migrations/journal.js";
import { previewLegacyAgentReset } from "./legacy-reset.js";

const resetRoots = ["agent-workspaces", "agent-sessions/pi", "script-agent"] as const;

function checkBusinessPaths(db: DatabaseSync) {
  const paths = db.prepare(`SELECT relative_path AS path FROM artifacts
    UNION ALL SELECT artifact_path FROM drafts
    UNION ALL SELECT artifact_path FROM workflow_versions
    UNION ALL SELECT source_ref FROM script_versions`);
  for (const { path } of paths.iterate()) {
    if (typeof path !== "string") continue;
    check(!resetRoots.some(root => path === root || path.startsWith(`${root}/`)),
      "AGENT_RESET_UNREVIEWED_DEPENDENCY", "业务资源引用待重置目录，须先核对归属", 409);
  }
}

/** Preview a stopped v10 installation. This function creates no backup or journal. */
export function previewAgentReset(dataRoot: string) {
  const root = realpathSync(resolve(dataRoot));
  const file = safe(root, "workbench.db");
  check(lstatSync(file).isFile(), "AGENT_RESET_SCHEMA_MISMATCH", "数据目录缺少数据库", 409);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const database = previewLegacyAgentReset(db);
    checkBusinessPaths(db);
    const filesystem = scan(root, resetRoots);
    const preservedExternalCodexReferences = Number(db.prepare(`SELECT count(*) AS n
      FROM agent_conversations WHERE CASE WHEN json_valid(backend_ref_json)
      THEN json_extract(backend_ref_json, '$.kind') = 'codex' ELSE 0 END`).get()!.n);
    const manifest = {
      database,
      filesystem,
      preservedExternalCodexReferences,
      backupRequired: true as const,
      quiescenceRequired: true as const,
    };
    return { ...manifest, confirmationToken: hash(canonical(manifest)) };
  } finally { db.close(); }
}
