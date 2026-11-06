import { Store } from "../persistence/store.js";
import { failure, check } from "../domain/errors.js";
import { assertSchema } from "../domain/validation.js";
import { executeScript, ScriptExecutionError } from "./script.js";

export class ScriptTestRunner {
  private active?: { id: string; controller: AbortController; job: Promise<void> };
  private closed = false;
  private enabled = false;
  constructor(readonly store: Store, autoStart = true) {
    for (const test of store.all<{ id: string }>("SELECT id FROM script_tests WHERE status='running'")) {
      store.finishScriptTest(test.id, { status: "failed", error: { code: "INTERRUPTED", message: "服务重启，测试已中断，请重新测试" }, stdout: "", stderr: "" });
    }
    if (autoStart) this.start();
  }
  start() { this.enabled = true; this.wake(); }
  enqueue(id: string) { this.wake(); return this.store.scriptTest(id); }
  cancel(id: string) {
    const test = this.store.scriptTest(id);
    if (this.active?.id === id) this.active.controller.abort();
    else if (test.status === "queued") {
      this.store.setScriptTestRunning(id);
      this.store.finishScriptTest(id, { status: "cancelled", stdout: "", stderr: "" });
    }
    return this.store.scriptTest(id);
  }
  private wake() {
    if (!this.enabled) return;
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
      let definition = this.store.scriptTestSnapshot(id);
      if (!definition) {
        const script = this.store.script(test.scriptId);
        const versionId = test.scriptVersionId ?? script.currentDraftVersionId;
        check(versionId, "NOT_FOUND", "脚本版本不存在");
        const version = this.store.scriptVersion(versionId);
        if (test.scriptVersionId) check(version.status === "published", "INVALID_STATE", "只能执行已发布脚本版本");
        else check(version.revision === test.draftRevision, "REVISION_CONFLICT", "脚本草稿已更新，请重新测试");
        definition = this.store.scriptDefinition(script.id, versionId);
      }
      assertSchema(test.input, definition.inputSchema, "脚本输入");
      const result = await executeScript({ ...definition, input: test.input, cwd: this.store.files.path("runs"), signal });
      try { assertSchema(result.output, definition.outputSchema, "脚本输出"); }
      catch (error) {
        this.store.finishScriptTest(id, { ...result, status: "failed", error: failure(error) });
        return;
      }
      this.store.finishScriptTest(id, { status: "succeeded", ...result });
    } catch (error) {
      this.store.finishScriptTest(id, { stdout: "", stderr: "", ...(error instanceof ScriptExecutionError ? error.execution : {}), status: signal.aborted ? "cancelled" : "failed", error: failure(error) });
    }
  }
}
