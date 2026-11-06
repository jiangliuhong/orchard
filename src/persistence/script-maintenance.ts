import { existsSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { Store } from "./store.js";
import { canonicalJson, digest } from "./files.js";
import { check } from "../domain/errors.js";

export interface ScriptRetention { keepDays: number; keepLatest: number }
export class ScriptMaintenance {
  constructor(readonly store: Store) {}
  private validate(policy: ScriptRetention) {
    check(Number.isInteger(policy.keepDays) && policy.keepDays >= 1 && policy.keepDays <= 3650, "INVALID_REQUEST", "保留天数须为 1 至 3650");
    check(Number.isInteger(policy.keepLatest) && policy.keepLatest >= 1 && policy.keepLatest <= 10000, "INVALID_REQUEST", "至少保留的记录数须为 1 至 10000");
  }
  private selection(scriptId: string, policy: ScriptRetention) {
    this.store.script(scriptId); this.validate(policy);
    const cutoff = Date.now() - policy.keepDays * 86400000;
    const rows = this.store.all<{ id: string; input_ref: string; output_ref: string; stdout_ref: string; stderr_ref: string }>(
      "SELECT * FROM script_tests WHERE id IN (SELECT id FROM script_tests WHERE script_id=? ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET ?) AND status NOT IN ('queued','running') AND created_at<? ORDER BY created_at DESC,id DESC LIMIT 1000",
      scriptId, policy.keepLatest, cutoff);
    return { rows, cutoff };
  }
  private describe(scriptId: string, policy: ScriptRetention, rows: { id: string }[]) {
    const ids = rows.map(test => test.id);
    return { count: ids.length, token: digest(canonicalJson({ scriptId, policy, ids })), policy, batchLimit: 1000 };
  }
  preview(scriptId: string, policy: ScriptRetention) {
    return this.describe(scriptId, policy, this.selection(scriptId, policy).rows);
  }
  private referenceIds(value: unknown, result = new Set<string>()) {
    if (typeof value !== "string") return result;
    let reference: { artifactId?: string; scriptSnapshot?: string };
    try { reference = JSON.parse(value); } catch { return result; }
    if (reference?.artifactId) result.add(reference.artifactId);
    if (reference?.scriptSnapshot) this.referenceIds(reference.scriptSnapshot, result);
    return result;
  }
  private reachable() {
    const roots = new Set<string>(), scan = (value: unknown) => {
      for (const hash of String(value ?? "").matchAll(/[a-f0-9]{64}/g)) roots.add(hash[0]);
    };
    const tables = this.store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='artifacts'");
    for (const { name } of tables) {
      check(/^[a-z_][a-z0-9_]*$/i.test(name), "INVALID_STATE", "数据表名称无效");
      for (let offset = 0; ; offset += 500) {
        const rows = this.store.all(`SELECT * FROM "${name}" LIMIT 500 OFFSET ?`, offset);
        for (const row of rows) for (const value of Object.values(row)) scan(value);
        if (rows.length < 500) break;
      }
    }
    const directory = this.store.files.path("script-agent");
    if (existsSync(directory)) for (const script of readdirSync(directory)) {
      if (!/^[a-z][a-z0-9-]{0,99}$/.test(script)) continue;
      const path = this.store.files.path(`script-agent/${script}`);
      if (!lstatSync(path).isDirectory()) continue;
      for (const file of readdirSync(path)) if (/^[a-f0-9]{64}\.json$/.test(file)) {
        const target = this.store.files.path(`script-agent/${script}/${file}`);
        if (lstatSync(target).size <= 12 * 1024 * 1024) scan(readFileSync(target, "utf8"));
      }
    }
    for (const hash of roots) {
      const artifact = this.store.one<{ relative_path: string; sha256: string; byte_size: number }>("SELECT relative_path,sha256,byte_size FROM artifacts WHERE id=?", hash);
      if (artifact) {
        try { scan(canonicalJson(this.store.files.readBlob(artifact.relative_path, artifact.sha256, artifact.byte_size))); }
        catch { throw new Error("存在不可验证的产物，已停止清理以保留数据"); }
      }
    }
    return roots;
  }
  clean(scriptId: string, input: ScriptRetention & { token: string; requestId: string }) {
    const scope = `script-clean:${scriptId}`;
    if (this.store.one("SELECT 1 FROM command_receipts WHERE scope=? AND request_id=?", scope, input.requestId)) return this.store.command(scope, input.requestId, input, () => { throw new Error("unreachable"); });
    const policy = { keepDays: input.keepDays, keepLatest: input.keepLatest }, selection = this.selection(scriptId, policy);
    const preview = this.describe(scriptId, policy, selection.rows);
    check(preview.token === input.token, "CLEANUP_CONFLICT", "清理范围已变化，请重新预览", 409);
    const paths: string[] = [];
    const result = this.store.command(scope, input.requestId, input, () => {
      const candidates = new Set<string>();
      let deletedTests = 0;
      for (const row of selection.rows) {
        const current = this.store.one<{ status: string }>("SELECT status FROM script_tests WHERE id=?", row.id);
        check(current && !["queued", "running"].includes(current.status), "CLEANUP_CONFLICT", "清理范围已变化，请重新预览", 409);
        for (const reference of [row.input_ref, row.output_ref, row.stdout_ref, row.stderr_ref]) this.referenceIds(reference, candidates);
        this.store.exec("DELETE FROM script_tests WHERE id=?", row.id); deletedTests++;
      }
      const roots = this.reachable();
      let freedBytes = 0;
      for (const hash of candidates) {
        if (roots.has(hash)) continue;
        const artifact = this.store.one<{ relative_path: string; byte_size: number }>("SELECT relative_path,byte_size FROM artifacts WHERE id=?", hash);
        if (!artifact || artifact.relative_path !== `artifacts/blobs/${hash}.json`) continue;
        paths.push(this.store.files.path(artifact.relative_path));
        this.store.exec("DELETE FROM artifacts WHERE id=?", hash); freedBytes += artifact.byte_size;
      }
      const scriptsDirectory = this.store.files.path("artifacts/scripts");
      if (existsSync(scriptsDirectory)) for (const hash of readdirSync(scriptsDirectory)) {
        if (!/^[a-f0-9]{64}$/.test(hash) || roots.has(hash)) continue;
        const path = this.store.files.path(`artifacts/scripts/${hash}`), info = lstatSync(path);
        if (!info.isDirectory() || info.mtimeMs >= selection.cutoff) continue;
        paths.push(path);
      }
      return { deletedTests, freedBytes, deletedArtifacts: paths.length };
    });
    for (const path of paths) rmSync(path, { force: true, recursive: true });
    return result;
  }
}
