const polling = new Map();
function startPolling(server, profileId, token) {
  const existing = polling.get(server);
  if (existing?.token === token) return;
  const session = { token };
  polling.set(server, session);
  const post = async (path, value) => {
    const response = await fetch(server + "/api/web-bridge/browser/" + path, {
      method: "POST", headers: { "content-type": "application/json", "x-orchard-bridge-token": token },
      body: JSON.stringify({ profileId, ...value }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("BRIDGE_UNAUTHORIZED");
    return response.json();
  };
  const poll = async () => {
    if (polling.get(server) !== session) return;
    try {
      const { items } = await post("poll", {});
      await Promise.all(items.map(async ({ id, payload }) => {
        let result;
        try { result = { result: await executeBrowserRequest(payload) }; }
        catch (error) { result = { error: error.message }; }
        await post("result", { id, ...result });
      }));
    } catch {}
    if (polling.get(server) === session) setTimeout(poll, 1000);
  };
  void poll();
}
async function executeBrowserRequest(payload) {
  const { origin, request, maxBytes, timeoutMs, deadline } = payload;
  const remainingMs = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
  if (remainingMs <= 0) throw new Error("BROWSER_REQUEST_FAILED");
  const tabs = (await chrome.tabs.query({})).filter(tab => {
    try { return new URL(tab.url).origin === origin; } catch { return false; }
  });
  // Never silently choose another account/session when several tabs match.
  const active = tabs.filter(tab => tab.active);
  const tab = tabs.length === 1 ? tabs[0] : active.length === 1 ? active[0] : undefined;
  if (!tab?.id) throw new Error("TAB_REQUIRED");
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, world: "MAIN",
    func: async (origin, request, maxBytes, timeoutMs) => {
      if (location.origin !== origin) return { error: "TAB_REQUIRED" };
      try {
        const url = new URL(request.path, origin);
        if (url.origin !== origin || !request.path.startsWith("/") || request.path.startsWith("//")) return { error: "INVALID_REQUEST" };
        const response = await fetch(url.href, {
          method: request.method, headers: request.headers, body: request.body,
          credentials: "include", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 401 || response.status === 403) return { error: "GATEWAY_AUTH_REQUIRED" };
        if (!response.ok) return { error: "BROWSER_REQUEST_FAILED" };
        if (request.method === "HEAD" || response.status === 204 || response.status === 205) return { result: null };
        if (!response.headers.get("content-type")?.toLowerCase().includes("json")) return { error: "GATEWAY_AUTH_REQUIRED" };
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) return { error: "RESPONSE_TOO_LARGE" };
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return { result: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
      } catch { return { error: "BROWSER_REQUEST_FAILED" }; }
    },
    args: [origin, request, maxBytes, remainingMs],
  });
  const value = results[0]?.result;
  if (!value || value.error) throw new Error(value?.error || "BROWSER_REQUEST_FAILED");
  return value.result;
}
let profileReady;
let registration = Promise.resolve();
let lastConnection;
const registrationAlarm = "orchard-profile-registration";

const getProfile = () => {
  if (!profileReady) {
    profileReady = (async () => {
      const stored = await chrome.storage.local.get(["profileId", "profileName"]);
      const id = stored.profileId || crypto.randomUUID();
      if (!stored.profileId) await chrome.storage.local.set({ profileId: id });
      return { id, name: stored.profileName || `Chrome · ${id.slice(0, 8)}`, extensionId: chrome.runtime.id };
    })().catch(error => {
      profileReady = undefined;
      throw error;
    });
  }
  return profileReady;
};

const registerProfile = () => {
  registration = registration.catch(() => {}).then(async () => {
    const profile = { ...await getProfile() };
    const servers = [];
    for (const port of [7441, 7443]) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/web-bridge/profiles/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile),
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const server = `http://127.0.0.1:${port}`;
          const registered = await response.json();
          if (registered.bridgeToken) startPolling(server, profile.id, registered.bridgeToken);
          servers.push(server);
        }
      } catch {}
    }
    if (!servers.length) console.warn("Orchard 浏览器资料注册失败，请确认本机服务已启动；插件会每 30 秒自动重连。");
    lastConnection = { profile, servers };
    return lastConnection;
  });
  return registration;
};

const reconnect = () => { void registerProfile().catch(error => console.warn("Orchard 浏览器资料连接失败", error)); };
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["profile:register", "profile:save", "profile:status"].includes(message?.type)) return;
  void (async () => {
    if (message.type === "profile:status") return { ok: true, ...(lastConnection ?? await registration) };
    if (message.type === "profile:save") {
      const name = typeof message.name === "string" ? message.name.trim() : "";
      if (!name || name.length > 100) throw new Error("请输入 1–100 个字符的浏览器资料名称。");
      const profile = await getProfile();
      await chrome.storage.local.set({ profileName: name });
      profile.name = name;
    }
    return { ok: true, ...await registerProfile() };
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.runtime.onInstalled.addListener(reconnect);
chrome.runtime.onStartup.addListener(reconnect);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === registrationAlarm) reconnect();
});
void (async () => {
  const alarm = await chrome.alarms.get(registrationAlarm);
  if (alarm?.periodInMinutes !== 0.5) await chrome.alarms.create(registrationAlarm, { periodInMinutes: 0.5 });
})().catch(error => console.warn("Orchard 自动重连初始化失败", error));
reconnect();
