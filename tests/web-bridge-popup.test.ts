import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { JSDOM } from "jsdom";

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(url = "https://example.com/account") {
  const dom = new JSDOM(readFileSync(new URL("../src/web-bridge/extension/popup.html", import.meta.url), "utf8"));
  let origins = ["http://127.0.0.1/*", "https://z.example/*", "https://example.com/*"];
  let failRemove = false;
  let connected = true;
  const removed: string[] = [];
  const copied: string[] = [];
  runInNewContext(readFileSync(new URL("../src/web-bridge/extension/popup.js", import.meta.url), "utf8"), {
    document: dom.window.document, window: dom.window, URL,
    navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
    chrome: {
      runtime: { sendMessage: async () => ({ ok: true, profile: { id: "profile-id", extensionId: "extension-id", name: "工作 Chrome" }, servers: connected ? ["http://127.0.0.1:7443"] : [] }) },
      tabs: {
        query: async () => [{ url }],
        onRemoved: { addListener() {} },
        onReplaced: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      permissions: {
        getAll: async () => ({ origins }),
        request: async ({ origins: added }: { origins: string[] }) => { origins.push(...added); return true; },
        remove: async ({ origins: targets }: { origins: string[] }) => {
          if (failRemove) throw new Error("test failure");
          removed.push(...targets);
          origins = origins.filter(origin => !targets.includes(origin));
          return true;
        },
      },
    },
  });
  const document = dom.window.document;
  const element = (id: string) => document.getElementById(id)!;
  return { dom, document, element, copied, removed, setFail: () => { failRemove = true; }, disconnect: () => { connected = false; } };
}

test("popup navigates in place, restores keyboard focus, and keeps feedback separate", async t => {
  const h = harness();
  t.after(() => h.dom.window.close());
  await tick();
  assert.match(h.element("connection-state").textContent!, /已连接/);
  assert.equal((h.element("save") as HTMLButtonElement).disabled, true);
  const name = h.element("profile-name") as HTMLInputElement;
  name.value = "新名称";
  name.dispatchEvent(new h.dom.window.Event("input"));
  assert.equal((h.element("save") as HTMLButtonElement).disabled, false);
  h.element("connection-link").click();
  assert.equal(h.element("home-view").hidden, true);
  assert.equal(h.document.activeElement, h.element("connection-title"));
  (h.document.querySelector(".copy") as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(h.copied, ["profile-id"]);
  h.disconnect();
  h.element("reconnect").click();
  await tick();
  assert.equal(h.element("connection-view").hidden, false);
  assert.match(h.element("status").textContent!, /Orchard 已启动/);
  assert.equal(h.element("connection-feedback").textContent, "已复制");
  h.document.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
  assert.equal(h.element("home-view").hidden, false);
  assert.equal(h.document.activeElement, h.element("connection-link"));
});

test("authorized sites exclude mandatory access, sort current first and revoke with confirmation", async t => {
  const h = harness();
  t.after(() => h.dom.window.close());
  await tick();
  assert.equal(h.element("sites-count").textContent, "2 个");
  assert.equal(h.element("grant-site").hidden, true);
  h.element("sites-link").click();
  await tick();
  assert.match(h.element("sites-list").firstElementChild!.textContent!, /example.com.*当前站点/);
  (h.document.querySelector(".revoke") as HTMLButtonElement).click();
  assert.equal(h.removed.length, 0);
  (h.document.querySelector(".confirmation button") as HTMLButtonElement).click();
  assert.equal(h.document.querySelector(".confirmation"), null);
  (h.document.querySelector(".revoke") as HTMLButtonElement).click();
  (h.document.querySelector(".confirmation .danger") as HTMLButtonElement).click();
  await tick();
  assert.deepEqual(h.removed, ["https://example.com/*"]);
  assert.equal(h.element("sites-count").textContent, "1 个");
  assert.equal(h.element("grant-site").hidden, false);
  assert.equal(h.element("sites-view").hidden, false);
  (h.document.querySelector("#sites-view .back") as HTMLButtonElement).click();
  h.element("grant-site").click();
  await tick();
  assert.equal(h.element("sites-count").textContent, "2 个");
  assert.match(h.element("site-feedback").textContent!, /已授权/);
});

test("permission failures remain actionable and restricted pages cannot request access", async t => {
  const h = harness("chrome://extensions");
  t.after(() => h.dom.window.close());
  await tick();
  assert.equal(h.element("grant-site").hidden, true);
  assert.match(h.element("site-state").textContent!, /仅支持/);
  h.element("sites-link").click();
  await tick();
  h.setFail();
  (h.document.querySelector(".revoke") as HTMLButtonElement).click();
  (h.document.querySelector(".confirmation .danger") as HTMLButtonElement).click();
  await tick();
  assert.match(h.element("sites-feedback").textContent!, /撤销失败/);
  assert.equal((h.document.querySelector(".revoke") as HTMLButtonElement).disabled, false);
  assert.equal(h.element("sites-count").textContent, "2 个");
});
