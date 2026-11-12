import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { createElement } from "react";
import { JSDOM } from "jsdom";
import type { MaintenanceReviewClient } from "../src/web/agent-chat/MaintenanceProposalReview.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "NodeFilter", "DocumentFragment", "MutationObserver", "Event", "CustomEvent", "getComputedStyle", "navigator"] as const)
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
const { render, screen, fireEvent, cleanup, waitFor, within } = await import("@testing-library/react");
const { MaintenanceProposalReview } = await import("../src/web/agent-chat/MaintenanceProposalReview.js");
afterEach(cleanup);
type Proposal = Awaited<ReturnType<MaintenanceReviewClient["get"]>>;
type Receipt = Awaited<ReturnType<MaintenanceReviewClient["receipt"]>>;
const proposal = (id = "p1"): Proposal => ({ id, target: { kind: "workflow_draft", id: "flow", scope: { draftId: "draft" } }, baseline: { revision: 1 }, summary: "Replace exact source", contentHash: "a".repeat(64), diffHash: "b".repeat(64), state: "pending", createdAt: Date.now(), expiresAt: Date.now() + 86400000,
  diff: { before: { files: { "scripts/old.ts": "old code" } }, after: { files: { "scripts/new.ts": "new code" } } } });
function fixture() {
  let view = proposal(), failApply = false;
  let result: Receipt = { id: "r1", proposalId: "p1", status: "queued", targetGeneration: null, result: null, errorCode: null, projection: { state: "ready", targetGeneration: 1, syncedGeneration: 1 } };
  const decisions: Parameters<MaintenanceReviewClient["decide"]>[1][] = [], applications: string[] = [];
  const client: MaintenanceReviewClient = {
    async get() { return { ...view }; },
    async decide(_id, value) { decisions.push(value); view = { ...view, state: value.action === "confirm" ? "confirmed" : "revoked" }; return view; },
    async apply(_id, key) { applications.push(key); if (failApply) { failApply = false; throw new Error("lost apply response"); } return result; },
    async receipt() { return result; },
  };
  return { client, decisions, applications, failApply() { failApply = true; }, result(status: string) { result = { ...result, status }; } };
}

test("review shows exact readonly before/after and deletion consequences; cancel/Escape never confirms", async () => {
  const f = fixture(); render(createElement(MaintenanceProposalReview, { proposalId: "p1", client: f.client }));
  const before = await screen.findByRole("textbox", { name: "提案修改前" }) as HTMLTextAreaElement;
  assert.equal(before.readOnly, true); assert.match(before.value, /old code/);
  assert.match(screen.getByRole("note").textContent!, /scripts\/old.ts/);
  fireEvent.click(screen.getByRole("button", { name: "审阅并确认应用" }));
  const dialog = await screen.findByRole("dialog", { name: "确认这份确切变更" });
  assert.equal((within(dialog).getByRole("button", { name: "确认并应用" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  assert.equal(f.decisions.length, 0); assert.equal(f.applications.length, 0);
  fireEvent.click(screen.getByRole("button", { name: "审阅并确认应用" }));
  await screen.findByRole("dialog"); fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(f.decisions.length, 0); assert.match((screen.getByRole("textbox", { name: "提案修改前" }) as HTMLTextAreaElement).value, /old code/);
});

test("confirmation binds displayed content/diff and queued/pending-sync states never trigger another model", async () => {
  const f = fixture(); let applied = 0;
  render(createElement(MaintenanceProposalReview, { proposalId: "p1", client: f.client, onApplied() { applied++; } }));
  fireEvent.click(await screen.findByRole("button", { name: "审阅并确认应用" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("checkbox")); fireEvent.click(within(dialog).getByRole("button", { name: "确认并应用" }));
  await screen.findByText("已排队，等待维护进程停止");
  assert.equal(f.decisions[0]!.contentHash, "a".repeat(64)); assert.equal(f.decisions[0]!.diffHash, "b".repeat(64));
  assert.equal(f.applications.length, 1); assert.equal(applied, 0);
  f.result("applied_projection_pending"); fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByText(/业务已应用，工作区待同步/); assert.equal(applied, 1);
  f.result("applied"); fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
  await screen.findByText("已应用（未自动发布）"); assert.equal(applied, 1); assert.equal(f.applications.length, 1);
});

test("lost apply response preserves confirmed review and retry reuses the exact application request key", async () => {
  const f = fixture(); f.failApply();
  render(createElement(MaintenanceProposalReview, { proposalId: "p1", client: f.client }));
  fireEvent.click(await screen.findByRole("button", { name: "审阅并确认应用" }));
  const dialog = await screen.findByRole("dialog"); fireEvent.click(within(dialog).getByRole("checkbox")); fireEvent.click(within(dialog).getByRole("button", { name: "确认并应用" }));
  await screen.findByText("lost apply response");
  fireEvent.click(screen.getByRole("button", { name: "提交应用请求" })); await screen.findByText("已排队，等待维护进程停止");
  assert.equal(f.decisions.length, 1); assert.equal(f.applications.length, 2); assert.equal(f.applications[0], f.applications[1]);
});

test("queued request can be revoked before commit without showing stale queued status or applying again", async () => {
  const f = fixture(); render(createElement(MaintenanceProposalReview, { proposalId: "p1", client: f.client }));
  fireEvent.click(await screen.findByRole("button", { name: "审阅并确认应用" }));
  const dialog = await screen.findByRole("dialog"); fireEvent.click(within(dialog).getByRole("checkbox")); fireEvent.click(within(dialog).getByRole("button", { name: "确认并应用" }));
  await screen.findByText("已排队，等待维护进程停止"); fireEvent.click(screen.getByRole("button", { name: "撤销提案" }));
  await screen.findByText("已撤销，未应用"); assert.equal(f.applications.length, 1); assert.equal(f.decisions[1]!.action, "revoke");
});
