import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { check } from "../domain/errors.js";
import { FileStore, json } from "./files.js";
import type { ScriptAgentTurn } from "../authoring/script-agent.js";

export class ScriptJournal {
  constructor(readonly files: FileStore) {}
  private directory(scriptId: string) {
    check(/^[a-z][a-z0-9-]{0,99}$/.test(scriptId), "INVALID_SCRIPT", "脚本 ID 无效");
    return this.files.path(`script-agent/${scriptId}`);
  }
  private path(scriptId: string, id: string) {
    this.directory(scriptId);
    check(/^[a-f0-9]{64}$/.test(id), "NOT_FOUND", "脚本 Agent 轮次不存在", 404);
    return this.files.path(`script-agent/${scriptId}/${id}.json`);
  }
  read(scriptId: string, id: string): ScriptAgentTurn | undefined {
    const path = this.path(scriptId, id);
    if (!existsSync(path)) return undefined;
    check(lstatSync(path).isFile() && lstatSync(path).size <= 12 * 1024 * 1024, "ARTIFACT_MISMATCH", "脚本 Agent 记录无效");
    const record = JSON.parse(readFileSync(path, "utf8")) as ScriptAgentTurn;
    check(record.scriptId === scriptId && record.id === id, "ARTIFACT_MISMATCH", "脚本 Agent 记录归属无效");
    return record;
  }
  list(scriptId: string) {
    const directory = this.directory(scriptId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const { snapshot, proposal, requestHash, ...record } = this.read(scriptId, name.slice(0, -5))!;
      return { ...record, summary: proposal?.summary };
    })
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }
  save(record: ScriptAgentTurn) {
    const path = this.path(record.scriptId, record.id), content = json(record);
    check(Buffer.byteLength(content) <= 12 * 1024 * 1024, "OUTPUT_LIMIT", "脚本 Agent 记录超限");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = this.files.path(`script-agent/${record.scriptId}/${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
