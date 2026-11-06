import { Store } from "../persistence/store.js";
import { failure, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { executeScript } from "./script.js";

export class ScriptTestRunner {
  private active?: { id: string; controller: AbortController; job: Promise<void> };
  private closed = false;
  constructor(readonly store: Store) { this.wake(); }
  enqueue(id: string) { this.wake(); return this.store.scriptTest(id); }
  private wake() {
    setImmediate(() => {
      if (this.active || this.closed) return;
      const next = this.store.one<{ id: string }>("SELECT id FROM script_tests WHERE status='queued' ORDER BY created_at,rowid LIMIT 1");
      if (!next) return;
      const controller = new AbortController();
      const job = this.run(next.id, controller.signal).finally(() => { this.active = undefined; this.wake(); });
      this.active = { id: next.id, controller, job };
    });
  }
  async close() { this.closed = true; if (this.active) { this.active.controller.abort(); await this.active.job; } }
  private async run(id: string, signal: AbortSignal) {
    let test = this.store.scriptTest(id);
    try {
      this.store.setScriptTestRunning(id); test = this.store.scriptTest(id);
      const script = this.store.script(test.scriptId);
      const versionId = test.scriptVersionId ?? script.currentDraftVersionId;
      check(versionId, "NOT_FOUND", "脚本版本不存在");
      const version = this.store.scriptVersion(versionId);
      if (test.scriptVersionId) check(version.status === "published", "INVALID_STATE", "只能执行已发布脚本版本");
      else check(version.revision === test.draftRevision, "REVISION_CONFLICT", "脚本草稿已更新，请重新测试");
      assertSchema(test.input, version.inputSchema, "脚本输入");
      const tree = this.store.files.readScriptTree(version.sourceRef);
      const result = await executeScript({ runtime: script.runtime, entryFile: version.entryFile, files: tree.files, input: test.input, cwd: this.store.files.path("runs"), timeoutMs: version.timeoutMs, signal });
      this.store.finishScriptTest(id, { status: "succeeded", ...result });
    } catch (error) {
      this.store.finishScriptTest(id, { status: signal.aborted ? "cancelled" : "failed", error: failure(error), stdout: "", stderr: "" });
    }
  }
}
