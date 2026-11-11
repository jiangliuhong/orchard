import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AgentControl, type AgentControlHost } from "../src/agent/control.js";
import { HostFeedbackDispatcher, type FeedbackHost } from "../src/agent/feedback.js";
import { executionFixture } from "./agent-execution-fixtures.js";

function controlFixture(t: TestContext, mode: "single" | "multi" = "multi") {
  const f = executionFixture(t, mode); if (mode === "multi") f.bind();
  let stopped = true, nativeDeletes = 0, releases = 0, authorized = true, failRelease = false, guarded = true;
  const host: AgentControlHost = {
    async authorize() { assert.ok(authorized, "permission denied"); },
    async stopAndConfirm() { return stopped ? "stopped" : "unknown"; },
    revoke() {},
    lifecycle(_conversation, guard) {
      return {
        async inspect() { return { status: "present" }; },
        async deleteSession(reference, signal) {
          const action = async () => { nativeDeletes++; return { status: "deleted" as const }; };
          return guarded ? guard.withStoppedSession(reference, signal, action) : action();
        },
      };
    },
    async releasePrivateResources() { releases++; if (failRelease) throw new Error("release failed"); },
  };
  const control = new AgentControl(f.store, f.locks, host);
  const input = { requestId: "delete", expectedRevision: f.store.conversation(f.actor, f.conversation.id).revision, confirmed: true };
  return { ...f, control, input, host, counts: () => ({ nativeDeletes, releases }), unknown() { stopped = false; }, stopped() { stopped = true; }, deny() { authorized = false; }, failRelease(value: boolean) { failRelease = value; }, bypassGuard() { guarded = false; } };
}

test("delete orchestrates native removal before platform content and retries actor-bound tombstones", async t => {
  const f = controlFixture(t), signal = new AbortController().signal;
  const result = await f.control.delete(f.actor, f.conversation.id, f.input, signal);
  assert.equal(result.status, "succeeded"); assert.equal(result.target_reference_json, null); assert.equal(result.conversation_id, null);
  assert.throws(() => f.store.conversation(f.actor, f.conversation.id), { code: "NOT_FOUND" });
  assert.equal((await f.control.delete(f.actor, f.conversation.id, f.input, signal)).id, result.id);
  assert.equal(f.counts().nativeDeletes, 1);
  await assert.rejects(f.control.delete("other", f.conversation.id, f.input, signal), { code: "NOT_FOUND" });
  await assert.rejects(f.control.delete(f.actor, f.conversation.id, { ...f.input, expectedRevision: 99 }, signal), { code: "REQUEST_CONFLICT" });
});

test("single without persistent backend deletes only platform-owned data", async t => {
  const f = controlFixture(t, "single");
  assert.equal((await f.control.delete(f.actor, f.conversation.id, f.input, new AbortController().signal)).status, "succeeded");
  assert.equal(f.counts().nativeDeletes, 0);
});

test("delete rejects missing confirmation, revoked authorization and stale revisions before side effects", async t => {
  const f = controlFixture(t), signal = new AbortController().signal;
  await assert.rejects(f.control.delete(f.actor, f.conversation.id, { ...f.input, confirmed: false }, signal), { code: "DELETE_CONFIRMATION_REQUIRED" });
  await assert.rejects(f.control.delete(f.actor, f.conversation.id, { ...f.input, expectedRevision: 99 }, signal), { code: "REVISION_CONFLICT" });
  f.deny(); await assert.rejects(f.control.delete(f.actor, f.conversation.id, f.input, signal), /permission denied/);
  assert.equal(f.store.conversation(f.actor, f.conversation.id).lifecycle, "active");
  assert.equal(f.counts().nativeDeletes, 0);
});

test("unknown process state retains exact reference and can retry the same durable operation", async t => {
  const f = controlFixture(t), signal = new AbortController().signal;
  f.unknown();
  const result = await f.control.delete(f.actor, f.conversation.id, f.input, signal);
  assert.equal(result.status, "unknown"); assert.equal(JSON.parse(result.error_json!).code, "PROCESS_STOP_UNCONFIRMED");
  assert.ok(result.target_reference_json); assert.equal(f.counts().nativeDeletes, 0);
  assert.equal(f.store.conversation(f.actor, f.conversation.id).lifecycle, "deleting");
  f.stopped();
  assert.equal((await f.control.delete(f.actor, f.conversation.id, f.input, signal)).status, "succeeded");
});

test("native success followed by resource/platform failure resumes without deleting native history twice", async t => {
  const f = controlFixture(t), signal = new AbortController().signal;
  f.failRelease(true);
  const result = await f.control.delete(f.actor, f.conversation.id, f.input, signal);
  assert.equal(result.phase, "provider_confirmed"); assert.equal(result.status, "unknown");
  assert.equal(f.counts().nativeDeletes, 1);
  const restarted = new AgentControl(f.store, f.locks, f.host);
  f.failRelease(false);
  assert.equal((await restarted.delete(f.actor, f.conversation.id, f.input, signal)).status, "succeeded");
  assert.equal(f.counts().nativeDeletes, 1);
});

test("unprotected native deletion claims cannot finalize platform deletion", async t => {
  const f = controlFixture(t); f.bypassGuard();
  const result = await f.control.delete(f.actor, f.conversation.id, f.input, new AbortController().signal);
  assert.equal(JSON.parse(result.error_json!).code, "NATIVE_DELETE_UNCONFIRMED");
  assert.ok(f.store.backend(f.actor, f.conversation.id));
});

function feedbackFixture(t: TestContext) {
  const f = executionFixture(t); f.bind();
  let deliveries = 0, inspections = 0, lost = false, nativePresent = false, uncertain = false;
  const host: FeedbackHost = {
    async authorize() {},
    async inspect(_conversation, feedback) {
      inspections++;
      return uncertain ? { status: "unknown" } : nativePresent ? { status: "delivered", receipt: { eventId: feedback.eventId, confirmed: true } } : { status: "absent" };
    },
    async deliver(_conversation, feedback) { deliveries++; nativePresent = true; if (lost) throw new Error("response lost"); return { eventId: feedback.eventId, confirmed: true }; },
  };
  f.store.enqueueFeedback(f.actor, f.conversation.id, { eventId: "fact-1", generation: 1, type: "resource_changed", payload: { revision: "8" } });
  return { ...f, host, dispatcher: new HostFeedbackDispatcher(f.store, f.locks, host), counts: () => ({ deliveries, inspections }), lose() { lost = true; }, uncertain() { uncertain = true; }, absent() { uncertain = false; nativePresent = false; lost = false; } };
}

test("host feedback delivers a durable fact once without generating turns", async t => {
  const f = feedbackFixture(t), signal = new AbortController().signal;
  assert.deepEqual(await f.dispatcher.flush(f.actor, f.conversation.id, signal), { delivered: 1, blocked: false });
  assert.deepEqual(await f.dispatcher.flush(f.actor, f.conversation.id, signal), { delivered: 0, blocked: false });
  assert.equal(f.counts().deliveries, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM agent_turns").get()!.n, 0);
});

test("lost feedback acknowledgment is inspected after restart, never blindly resent", async t => {
  const f = feedbackFixture(t), signal = new AbortController().signal; f.lose();
  assert.deepEqual(await f.dispatcher.flush(f.actor, f.conversation.id, signal), { delivered: 0, blocked: true });
  assert.equal(f.store.pendingFeedback(f.actor, f.conversation.id)[0]!.status, "unknown");
  const restarted = new HostFeedbackDispatcher(f.store, f.locks, f.host);
  assert.deepEqual(await restarted.flush(f.actor, f.conversation.id, signal), { delivered: 1, blocked: false });
  assert.equal(f.counts().deliveries, 1); assert.equal(f.counts().inspections, 1);
});

test("unknown feedback blocks successors; authoritative absence permits a retry", async t => {
  const f = feedbackFixture(t), signal = new AbortController().signal; f.lose();
  await f.dispatcher.flush(f.actor, f.conversation.id, signal);
  f.store.enqueueFeedback(f.actor, f.conversation.id, { eventId: "fact-2", generation: 1, type: "resource_changed", payload: { revision: "9" } });
  f.uncertain(); assert.deepEqual(await f.dispatcher.flush(f.actor, f.conversation.id, signal), { delivered: 0, blocked: true });
  assert.equal(f.counts().deliveries, 1);
  f.absent(); assert.deepEqual(await f.dispatcher.flush(f.actor, f.conversation.id, signal), { delivered: 2, blocked: false });
  assert.equal(f.counts().deliveries, 3);
});
