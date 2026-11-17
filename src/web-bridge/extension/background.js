const polling = new Map();
function startPolling(server, profileId, token) {
  const existing = polling.get(server);
  if (existing?.token === token) return;
  for (const controller of existing?.active.values() ?? []) controller.abort();
  const active = new Map();
  const session = { token, active };
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
      const activeIds = [...active.keys()];
      const reply = await post("poll", { activeIds });
      if (Array.isArray(reply.activeIds)) {
        const remaining = new Set(reply.activeIds);
        for (const id of activeIds) if (!remaining.has(id)) active.get(id)?.abort();
      }
      for (const { id, payload } of reply.items) {
        const controller = new AbortController();
        active.set(id, controller);
        void (async () => {
          try {
            let result;
            try { result = { result: await executeBrowserRequest(payload, id, controller.signal) }; }
            catch (error) { result = { error: error.message }; }
            if (!controller.signal.aborted) await post("result", { id, ...result });
          } catch {} finally { active.delete(id); }
        })();
      }
    } catch {}
    if (polling.get(server) === session) setTimeout(poll, 1000);
  };
  void poll();
}
const bindingKey = "bridgeTabBindings";
let tabOperations = Promise.resolve();

function withTabBindings(operation) {
  const result = tabOperations.then(async () => {
    const stored = await chrome.storage.session.get(bindingKey);
    return operation(stored[bindingKey] ?? {});
  });
  tabOperations = result.catch(() => {});
  return result;
}

function tabOrigin(url) {
  try { return new URL(url).origin; } catch { return undefined; }
}

function canAccessOrigin(origin) {
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

function saveBindings(bindings) {
  return chrome.storage.session.set({ [bindingKey]: bindings });
}

async function releaseTab(bindings, origin, tab) {
  const binding = bindings[origin];
  if (tab && binding.restoreAutoDiscardable && tab.autoDiscardable === false) {
    try { await chrome.tabs.update(tab.id, { autoDiscardable: true }); }
    catch (error) {
      // A closed tab has no setting left to restore.
      if (await chrome.tabs.get(tab.id).catch(() => undefined)) throw error;
    }
  }
  delete bindings[origin];
  await saveBindings(bindings);
}

function manageBridgeTab(origin, selectedId) {
  return withTabBindings(async bindings => {
    const allTabs = await chrome.tabs.query({});
    const tabs = allTabs.filter(tab => tab.id !== undefined && tabOrigin(tab.url) === origin);
    let binding = bindings[origin];
    let primary = allTabs.find(tab => binding && tab.id === binding.tabId);
    if (binding && (!primary || tabOrigin(primary.url) !== origin || !await canAccessOrigin(origin))) {
      await releaseTab(bindings, origin, primary);
      primary = undefined;
      binding = undefined;
    }

    const available = tabs.filter(tab => !tab.discarded && !tab.frozen &&
      (!tab.pendingUrl || tabOrigin(tab.pendingUrl) === origin));
    // Tab IDs are browser-session scoped. Keep only the fact of a previous
    // binding across browser restarts so a replacement always requires consent.
    const historyKey = "bridgeTabPreviouslyBound:" + origin;
    const previouslyBound = (await chrome.storage.local.get(historyKey))[historyKey];
    const selected = selectedId === undefined
      ? (!binding && !previouslyBound && tabs.length === 1 ? available[0] : undefined)
      : available.find(tab => tab.id === selectedId);
    if (selectedId !== undefined && !selected) throw new Error("TAB_UNAVAILABLE");
    if (selected && selected.id !== binding?.tabId) {
      if (!await canAccessOrigin(origin)) throw new Error("TAB_REQUIRED");
      if (binding) await releaseTab(bindings, origin, primary);
      await chrome.storage.local.set({ [historyKey]: true });
      binding = { tabId: selected.id, restoreAutoDiscardable: selected.autoDiscardable !== false };
      bindings[origin] = binding;
      await saveBindings(bindings);
      primary = selected;
    }
    if (primary && !primary.discarded && primary.autoDiscardable !== false) {
      primary = await chrome.tabs.update(primary.id, { autoDiscardable: false });
    }
    const ready = primary?.autoDiscardable === false && tabOrigin(primary.url) === origin && !primary.discarded && !primary.frozen &&
      (!primary.pendingUrl || tabOrigin(primary.pendingUrl) === origin);
    return {
      tabId: binding?.tabId,
      state: ready ? "ready" : primary?.discarded ? "discarded" : primary?.frozen ? "frozen"
        : binding ? "unavailable" : previouslyBound || tabs.length > 1 ? "select" : "missing",
      tabs: tabs.map(tab => ({
        id: tab.id, windowId: tab.windowId, index: tab.index, title: tab.title, url: tab.url,
        available: available.includes(tab),
      })),
    };
  });
}

function reconcileBridgeTabs(tabId, removed, navigatedUrl) {
  void withTabBindings(async bindings => {
    for (const [origin, binding] of Object.entries(bindings)) {
      if (tabId !== undefined && binding.tabId !== tabId) continue;
      const tab = removed ? undefined : await chrome.tabs.get(binding.tabId).catch(() => undefined);
      if (!tab || tabOrigin(tab.url) !== origin || (navigatedUrl && tabOrigin(navigatedUrl) !== origin) ||
          !await canAccessOrigin(origin)) {
        await releaseTab(bindings, origin, tab);
      }
    }
  }).catch(error => console.warn("Orchard 无法更新桥接页签绑定", error));
}

async function executeBrowserRequest(payload, id, cancellation) {
  const { origin, request, sequence, maxBytes, timeoutMs, deadline } = payload;
  if (deadline && deadline <= Date.now()) throw new Error("BROWSER_REQUEST_FAILED");
  const binding = await manageBridgeTab(origin);
  if (binding.state !== "ready") {
    const errors = { select: "TAB_SELECTION_REQUIRED", discarded: "TAB_DISCARDED", frozen: "TAB_FROZEN" };
    throw new Error(errors[binding.state] || "TAB_REQUIRED");
  }
  const remainingMs = deadline ? Math.min(timeoutMs, deadline - Date.now()) : timeoutMs;
  if (remainingMs <= 0) throw new Error("BROWSER_REQUEST_FAILED");
  cancellation?.throwIfAborted();
  const cancel = () => {
    if (!sequence || !id) return;
    void chrome.scripting.executeScript({
      target: { tabId: binding.tabId }, world: "ISOLATED",
      func: id => globalThis.__orchardBrowserCalls?.get(id)?.abort(), args: [id],
    }).catch(() => {});
  };
  cancellation?.addEventListener("abort", cancel, { once: true });
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId }, world: sequence ? "ISOLATED" : "MAIN",
      func: async (origin, initial, sequence, maxBytes, timeoutMs, id) => {
        if (location.origin !== origin) return { error: "TAB_REQUIRED" };
        const controller = sequence && id ? new AbortController() : undefined;
        let calls;
        if (controller) {
          calls = globalThis.__orchardBrowserCalls ??= new Map();
          calls.set(id, controller);
        }
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = controller ? AbortSignal.any([controller.signal, timeout]) : timeout;
        const flow = sequence?.flow;
        const variables = new Map(Object.entries(initial?.variables ?? {}));
        const secrets = new Map();
        const own = (value, at) => at.reduce((part, key) => part && Object.hasOwn(part, key) ? part[key] : undefined, value);
        const fail = code => { throw new Error(code); };
        const requestJson = async request => {
          signal.throwIfAborted();
          const url = new URL(request.path, origin);
          if (url.origin !== origin || !request.path.startsWith("/") || request.path.startsWith("//") ||
              /[?#]/.test(request.path)) fail("INVALID_REQUEST");
          for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.append(key, value);
          if (url.href.length > 32768) fail("INVALID_REQUEST");
          const response = await fetch(url.href, {
            method: request.method, headers: request.headers, body: request.body,
            credentials: "include", redirect: "error", signal,
          });
          if (response.status === 401 || response.status === 403) fail("GATEWAY_AUTH_REQUIRED");
          if (!response.ok) fail("BROWSER_REQUEST_FAILED");
          if (request.method === "HEAD" || response.status === 204 || response.status === 205) return null;
          if (!response.headers.get("content-type")?.toLowerCase().includes("json")) fail("GATEWAY_AUTH_REQUIRED");
          const reader = response.body.getReader();
          let size = 0;
          const chunks = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxBytes) fail("RESPONSE_TOO_LARGE");
              chunks.push(value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        };
        const positiveInteger = value => /^[1-9][0-9]*$/.test(String(value)) && Number.isSafeInteger(Number(value));
        const capture = (definitions, response) => {
          for (const [name, spec] of Object.entries(definitions ?? {})) {
            let value = own(response, spec.at);
            if (spec.match) {
              const expected = variables.get(spec.match.equalsFrom);
              if (!Array.isArray(value) || expected === undefined || secrets.has(spec.match.equalsFrom)) fail("BROWSER_FLOW_FAILED");
              const matches = value.filter(item => own(item, spec.match.field) === expected);
              if (matches.length !== 1) fail(matches.length ? "BROWSER_FLOW_MATCH_AMBIGUOUS" : "BROWSER_FLOW_MATCH_NOT_FOUND");
              value = own(matches[0], spec.match.value);
            }
            if (spec.optional && (value === undefined || value === null || value === "")) {
              (spec.secret ? secrets : variables).delete(name);
              continue;
            }
            if ((typeof value !== "string" && typeof value !== "number") ||
                !String(value) || String(value).length > 8192) fail("BROWSER_FLOW_FAILED");
            if (spec.positiveInteger && !positiveInteger(value)) fail("BROWSER_FLOW_FAILED");
            (spec.secret ? secrets : variables).set(name, String(value));
          }
        };
        const expand = (template, context) => template.replace(/\{([A-Za-z][A-Za-z0-9_]*)(:rison)?\}/g, (_, key, rison) => {
          const value = (context === "header" && secrets.has(key) ? secrets : variables).get(key);
          if (value === undefined || (secrets.has(key) && context !== "header")) fail("BROWSER_FLOW_FAILED");
          if (context === "path" && (!/^[A-Za-z0-9_-]+$/.test(value) || rison)) fail("INVALID_REQUEST");
          if (rison) {
            if (context !== "query") fail("INVALID_REQUEST");
            return "'" + value.replace(/!/g, "!!").replace(/'/g, "!'") + "'";
          }
          return value;
        });
        const fields = (entries, context) => Object.fromEntries(
          Object.entries(entries ?? {}).map(([key, template]) => [key, expand(template, context)]),
        );
        try {
          let result = await requestJson(initial);
          if (!flow) return { result };
          for (const group of [flow.capture, ...flow.steps.map(step => step.capture)]) {
            if (Object.keys(group ?? {}).some(name => variables.has(name))) fail("BROWSER_FLOW_FAILED");
          }
          capture(flow.capture, result);
          for (const step of flow.steps) {
            if (step.when && (!variables.has(step.when) || secrets.has(step.when))) continue;
            const path = expand(step.path, "path");
            if (/[{}]/.test(path)) fail("INVALID_REQUEST");
            const headers = fields(step.headers, "header");
            if (Object.values(headers).some(value => value.length > 8192 || /[\r\n\u0000]/.test(value))) fail("INVALID_REQUEST");
            let body = step.bodyFrom ? variables.get(step.bodyFrom) : undefined;
            if (step.bodyFrom && (body === undefined || secrets.has(step.bodyFrom))) fail("BROWSER_FLOW_FAILED");
            if (step.jsonFields) {
              let json;
              try { json = JSON.parse(body); } catch { fail("BROWSER_FLOW_FAILED"); }
              if (!json || typeof json !== "object" || Array.isArray(json)) fail("BROWSER_FLOW_FAILED");
              const additions = Object.entries(step.jsonFields).map(([key, spec]) => {
                const value = variables.get(spec.from);
                if (value === undefined || secrets.has(spec.from)) fail("BROWSER_FLOW_FAILED");
                if (spec.type === "positiveInteger") {
                  if (!positiveInteger(value)) fail("BROWSER_FLOW_FAILED");
                  return [key, Number(value)];
                }
                return [key, value];
              });
              body = JSON.stringify({ ...json, ...Object.fromEntries(additions) });
              if (new TextEncoder().encode(body).byteLength > 262144) fail("INVALID_REQUEST");
            }
            const request = { path, method: step.method, headers, query: fields(step.query, "query"), body };
            const poll = step.poll;
            for (let attempt = 1; ; attempt++) {
              result = await requestJson(request);
              if (!poll) break;
              const status = String(own(result, poll.at) ?? "").toLowerCase();
              if (poll.failure.some(value => value.toLowerCase() === status)) fail("BROWSER_FLOW_FAILED");
              if (poll.success.some(value => value.toLowerCase() === status)) break;
              if (attempt >= poll.maxAttempts) fail("BROWSER_FLOW_TIMEOUT");
              await new Promise((resolve, reject) => {
                signal.throwIfAborted();
                const abort = () => { clearTimeout(timer); reject(signal.reason); };
                const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, poll.intervalMs);
                signal.addEventListener("abort", abort, { once: true });
              });
            }
            capture(step.capture, result);
          }
          const output = JSON.stringify(result);
          for (const secret of secrets.values()) {
            if (output.includes(secret) || output.includes(JSON.stringify(secret).slice(1, -1))) fail("SENSITIVE_RESPONSE");
          }
          return { result };
        } catch (error) {
          if (signal.aborted && flow) return { error: "BROWSER_FLOW_TIMEOUT" };
          const codes = ["TAB_REQUIRED", "INVALID_REQUEST", "GATEWAY_AUTH_REQUIRED", "BROWSER_REQUEST_FAILED",
            "RESPONSE_TOO_LARGE", "BROWSER_FLOW_FAILED", "BROWSER_FLOW_TIMEOUT", "SENSITIVE_RESPONSE",
            "BROWSER_FLOW_MATCH_NOT_FOUND", "BROWSER_FLOW_MATCH_AMBIGUOUS"];
          return { error: codes.includes(error?.message) ? error.message : "BROWSER_REQUEST_FAILED" };
        } finally {
          calls?.delete(id);
        }
      },
      args: [origin, sequence?.initial ?? request, sequence ?? null, maxBytes, remainingMs, id ?? null],
    });
  } finally {
    cancellation?.removeEventListener("abort", cancel);
  }
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
      return { id, name: stored.profileName || `Chrome · ${id.slice(0, 8)}`, extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest?.().version };
    })().catch(error => {
      profileReady = undefined;
      throw error;
    });
  }
  return profileReady;
};

function discoverServer() {
  if (!chrome.runtime.connectNative) return Promise.resolve();
  return new Promise(resolve => {
    let port, timer, settled = false;
    const id = crypto.randomUUID();
    const finish = message => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      port?.onMessage.removeListener(onMessage);
      port?.onDisconnect.removeListener(onDisconnect);
      try { port?.disconnect(); } catch { /* The host may already have exited. */ }
      resolve(message);
    };
    const onMessage = message => { if (message?.id === id) finish(message); };
    const onDisconnect = () => { void chrome.runtime.lastError; finish(); };
    try {
      port = chrome.runtime.connectNative("com.jiangliuhong.orchard");
      port.onMessage.addListener(onMessage); port.onDisconnect.addListener(onDisconnect);
      timer = setTimeout(() => finish(), 3000);
      port.postMessage({ id, type: "discover" });
    } catch { finish(); }
  });
}

const registerProfile = () => {
  registration = registration.catch(() => {}).then(async () => {
    const profile = { ...await getProfile() };
    const servers = [];
    const defaults = ["http://127.0.0.1:7441", "http://127.0.0.1:7443"];
    const register = async server => {
      try {
        const response = await fetch(`${server}/api/web-bridge/profiles/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(profile),
          signal: AbortSignal.timeout(3000),
        });
        if (response.ok) {
          const registered = await response.json();
          if (registered.bridgeToken) startPolling(server, profile.id, registered.bridgeToken);
          servers.push(server);
        }
      } catch {}
    };
    // Default HTTP connections do not depend on a working Native Host.
    const direct = Promise.all(defaults.map(register));
    const discovered = discoverServer().then(async discovery => {
      try {
        const url = new URL(discovery?.result?.serverUrl);
        if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !defaults.includes(url.origin)) await register(url.origin);
      } catch { /* Default HTTP ports remain available without a Native Host installation. */ }
    });
    await Promise.all([direct, discovered]);
    if (!servers.length) console.warn("Orchard 浏览器资料注册失败，请确认本机服务已启动；插件会每 30 秒自动重连。");
    lastConnection = { profile, servers };
    return lastConnection;
  });
  return registration;
};

const reconnect = () => { void registerProfile().catch(error => console.warn("Orchard 浏览器资料连接失败", error)); };
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !["profile:register", "profile:save", "profile:status", "tab:status", "tab:bind"].includes(message?.type)) return;
  void (async () => {
    if (message.type === "tab:status" || message.type === "tab:bind") {
      const origin = message.origin;
      if (sender.url !== chrome.runtime.getURL("popup.html") || typeof origin !== "string" ||
          tabOrigin(origin) !== origin || !await canAccessOrigin(origin)) throw new Error("TAB_REQUIRED");
      if (message.type === "tab:bind" && !Number.isInteger(message.tabId)) throw new Error("TAB_UNAVAILABLE");
      return { ok: true, ...await manageBridgeTab(origin, message.tabId) };
    }
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
chrome.tabs.onRemoved.addListener(tabId => reconcileBridgeTabs(tabId, true));
chrome.tabs.onReplaced.addListener((_addedId, removedId) => reconcileBridgeTabs(removedId, true));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) reconcileBridgeTabs(tabId, false, change.url);
});
chrome.permissions.onRemoved.addListener(() => reconcileBridgeTabs());
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
