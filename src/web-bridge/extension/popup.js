const $ = id => document.getElementById(id);
const form = $("profile-form");
const nameInput = $("profile-name");
const saveButton = $("save");
const reconnectButton = $("reconnect");
const status = $("status");
let refreshTimer;
let busy = false;
let closed = false;
let profileName;
let currentView = "home";
let returnTarget;
let currentOrigin;
let grantedOrigins = [];
let permissionsReady = false;
let permissionBusy = false;
let tabBusy = false;
let boundTabId;
let tabRefresh = 0;
const tabSelect = $("bridge-tab");
const tabForm = $("bridge-tab-form");

function showView(view, trigger) {
  if (trigger) returnTarget = trigger;
  for (const name of ["home", "connection", "sites"]) $(name + "-view").hidden = name !== view;
  currentView = view;
  if (view === "home") returnTarget?.focus();
  else $(view + "-title").focus();
}
$("connection-link").addEventListener("click", () => showView("connection", $("connection-link")));
$("sites-link").addEventListener("click", () => { showView("sites", $("sites-link")); void loadPermissions(); });
document.querySelectorAll(".back").forEach(button => button.addEventListener("click", () => showView("home")));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && currentView !== "home") {
    event.preventDefault();
    event.stopPropagation();
    showView("home");
  }
});

function updateSave() {
  saveButton.disabled = busy || profileName === undefined || !nameInput.value.trim() || nameInput.value.trim() === profileName;
}
nameInput.addEventListener("input", () => { updateSave(); $("profile-feedback").textContent = ""; });
function connectionState(state, text, detail) {
  $("connection-state").dataset.state = state;
  $("connection-state").textContent = `${state === "success" ? "●" : "○"} ${text}`;
  status.dataset.state = state;
  status.textContent = detail;
}
const connect = async (save = false, automatic = false) => {
  if (busy || closed) return;
  busy = true;
  window.clearTimeout(refreshTimer);
  nameInput.disabled = !automatic;
  updateSave();
  reconnectButton.disabled = true;
  reconnectButton.textContent = automatic ? "重新连接" : "连接中…";
  if (!automatic) connectionState("loading", "连接中…", "正在连接本机服务…");
  try {
    const result = await chrome.runtime.sendMessage(save ? { type: "profile:save", name: nameInput.value.trim() } : { type: automatic ? "profile:status" : "profile:register" });
    if (!result?.ok) throw new Error(result?.error || "无法连接插件后台，请重新加载插件后重试。");
    if (save || profileName === undefined || nameInput.value === profileName) nameInput.value = result.profile.name;
    profileName = result.profile.name;
    $("profile-id").textContent = result.profile.id;
    $("extension-id").textContent = result.profile.extensionId;
    $("servers").textContent = result.servers.length ? result.servers.join("\n") : "尚未连接";
    connectionState(result.servers.length ? "success" : "error", result.servers.length ? "已连接" : "未连接", result.servers.length ? "已连接本机服务" : "尚未连接本机服务，请确认 Orchard 已启动。自动重连已开启。");
    if (save) {
      $("profile-feedback").dataset.state = "success";
      $("profile-feedback").textContent = "名称已保存，请在工作台刷新浏览器资料。";
    }
  } catch (error) {
    connectionState("error", "未连接", error.message);
    if (save) {
      $("profile-feedback").dataset.state = "error";
      $("profile-feedback").textContent = `保存失败：${error.message}`;
    }
  } finally {
    busy = false;
    nameInput.disabled = false;
    updateSave();
    reconnectButton.disabled = false;
    reconnectButton.textContent = "重新连接";
    if (!closed) refreshTimer = window.setTimeout(() => { void connect(false, true); }, 5000);
  }
};
form.addEventListener("submit", event => { event.preventDefault(); void connect(true); });
reconnectButton.addEventListener("click", () => { void connect(); });
window.addEventListener("pagehide", () => { closed = true; window.clearTimeout(refreshTimer); });
document.querySelectorAll(".copy").forEach(button => button.addEventListener("click", async () => {
  try {
    const value = $(button.dataset.target).textContent;
    if (value === "—") throw new Error("暂无可复制的 ID");
    await navigator.clipboard.writeText(value);
    $("connection-feedback").textContent = "已复制";
  } catch { $("connection-feedback").textContent = "复制失败，请手动选择并复制 ID。"; }
}));

// Only optional host permissions belong here; mandatory local bridge access is never revocable.
function isOptionalOrigin(pattern) {
  return pattern.startsWith("https://") || pattern === "http://localhost/*";
}
async function loadPermissions() {
  try {
    const permissions = await chrome.permissions.getAll();
    grantedOrigins = [...new Set((permissions.origins || []).filter(isOptionalOrigin))];
    permissionsReady = true;
    $("sites-feedback").textContent = "";
    renderPermissions();
    await refreshBridgeTabs();
  } catch {
    permissionsReady = false;
    $("sites-summary").textContent = "无法读取已授权站点";
    $("sites-count").textContent = "—";
    $("sites-feedback").textContent = "请返回后重试。";
    updateCurrentSite();
  }
}
function updateCurrentSite() {
  const mandatoryLocal = currentOrigin && new URL(currentOrigin).protocol === "http:" && new URL(currentOrigin).hostname === "127.0.0.1";
  const granted = mandatoryLocal || (permissionsReady && grantedOrigins.some(pattern => matchesOrigin(pattern, currentOrigin)));
  $("site-state").textContent = !currentOrigin ? "仅支持 HTTPS 或本机站点" : !permissionsReady ? "无法读取授权状态" : granted ? "✓ 已授权" : "未授权";
  $("grant-site").hidden = !!granted || !currentOrigin;
  $("grant-site").disabled = !currentOrigin || !permissionsReady || permissionBusy;
  tabForm.hidden = !granted;
}
function updateTabButton() {
  $("bind-tab").disabled = tabBusy || !tabSelect.value || Number(tabSelect.value) === boundTabId;
}

async function refreshBridgeTabs(selectedId) {
  if (closed || tabForm.hidden || (tabBusy && selectedId === undefined)) return;
  const refresh = ++tabRefresh;
  const status = $("bridge-tab-status");
  try {
    const message = selectedId === undefined ? { type: "tab:status" } : { type: "tab:bind", tabId: selectedId };
    const result = await chrome.runtime.sendMessage({ ...message, origin: currentOrigin });
    if (closed || refresh !== tabRefresh) return;
    if (!result?.ok) throw new Error(result?.error);
    const previousSelection = tabSelect.value;
    const previousBinding = boundTabId;
    boundTabId = result.tabId;
    tabSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择页签";
    tabSelect.append(placeholder);
    for (const tab of result.tabs) {
      const option = document.createElement("option");
      option.value = String(tab.id);
      option.textContent = `窗口 ${tab.windowId} · 页签 ${tab.index + 1} · ${tab.title || tab.url}`;
      if (tab.id === boundTabId) option.textContent += "（主桥接页签）";
      option.disabled = !tab.available;
      tabSelect.append(option);
    }
    const choice = selectedId === undefined && previousBinding === boundTabId
      ? result.tabs.find(tab => String(tab.id) === previousSelection && (tab.available || tab.id === boundTabId))
      : undefined;
    tabSelect.value = String(choice?.id ?? boundTabId ?? "");
    tabSelect.disabled = result.tabs.length === 0;
    status.dataset.state = result.state === "ready" ? "success" : "";
    status.textContent = {
      ready: "主桥接页签已绑定，已防止浏览器自动回收。",
      select: result.tabs.length ? "请选择已登录所需账号的主桥接页签。" : "请打开站点并重新选择主桥接页签。",
      missing: result.tabs.length ? "请先切换到业务页签使其恢复运行。" : "请打开业务页签。",
      discarded: "主桥接页签已被回收，请切换到该页签恢复，或手动选择其他页签。",
      frozen: "主桥接页签已冻结，请切换到该页签恢复，或手动选择其他页签。",
      unavailable: "主桥接页签暂不可用，请检查业务页签。",
    }[result.state];
  } catch {
    if (closed || refresh !== tabRefresh) return;
    status.dataset.state = "error";
    status.textContent = "无法更新桥接页签，请检查站点授权和页签状态后重试。";
  } finally {
    updateTabButton();
  }
}

tabSelect.addEventListener("change", updateTabButton);
tabForm.addEventListener("submit", async event => {
  event.preventDefault();
  if ($("bind-tab").disabled) return;
  tabBusy = true;
  tabSelect.disabled = true;
  updateTabButton();
  try { await refreshBridgeTabs(Number(tabSelect.value)); }
  finally {
    tabBusy = false;
    tabSelect.disabled = tabSelect.options.length <= 1;
    updateTabButton();
  }
});

function matchesOrigin(pattern, origin) {
  if (!origin) return false;
  const match = pattern.match(/^(https?):\/\/([^/]+)\/\*$/);
  if (!match) return false;
  const url = new URL(origin);
  const host = match[2];
  return url.protocol === match[1] + ":" && (host === "*" || host === url.host || (host.startsWith("*.") && (url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)))));
}
function renderPermissions(focusPattern) {
  $("sites-count").textContent = `${grantedOrigins.length} 个`;
  $("sites-summary").textContent = grantedOrigins.length ? `已授权 ${grantedOrigins.length} 个站点` : "暂无已授权站点，请返回主页授权。";
  const list = $("sites-list");
  list.replaceChildren();
  const sorted = [...grantedOrigins].sort((a, b) => Number(matchesOrigin(b, currentOrigin)) - Number(matchesOrigin(a, currentOrigin)) || a.localeCompare(b));
  for (const pattern of sorted) {
    const row = document.createElement("li");
    row.className = "site-row";
    const main = document.createElement("div");
    main.className = "site-row-main";
    const label = document.createElement("div");
    label.className = "site-label";
    label.textContent = pattern.replace(/\/\*$/, "");
    if (matchesOrigin(pattern, currentOrigin)) {
      const marker = document.createElement("span");
      marker.className = "current-marker";
      marker.textContent = "当前站点";
      label.append(marker);
    }
    const revoke = document.createElement("button");
    revoke.className = "secondary revoke";
    revoke.textContent = "撤销授权";
    revoke.setAttribute("aria-label", `撤销 ${pattern} 的授权`);
    revoke.disabled = permissionBusy;
    main.append(label, revoke);
    row.append(main);
    list.append(row);
    if (focusPattern === pattern) revoke.focus();
    revoke.addEventListener("click", () => {
      if (row.querySelector(".confirmation")) return;
      const confirmation = document.createElement("div");
      confirmation.className = "confirmation";
      const prompt = document.createElement("span");
      prompt.textContent = "确认撤销？";
      const cancel = document.createElement("button");
      cancel.textContent = "取消";
      const confirm = document.createElement("button");
      confirm.textContent = "撤销";
      confirm.className = "danger";
      cancel.addEventListener("click", () => { confirmation.remove(); revoke.focus(); });
      confirm.addEventListener("click", async () => {
        if (permissionBusy) return;
        permissionBusy = true;
        list.querySelectorAll("button").forEach(button => { button.disabled = true; });
        updateCurrentSite();
        try {
          if (!await chrome.permissions.remove({ origins: [pattern] })) throw new Error("未能撤销授权");
          await loadPermissions();
          $("sites-feedback").textContent = "已撤销授权";
          $("sites-title").focus();
        } catch (error) {
          $("sites-feedback").textContent = `撤销失败：${error.message}`;
        } finally {
          permissionBusy = false;
          renderPermissions(grantedOrigins.includes(pattern) ? pattern : undefined);
        }
      });
      confirmation.append(prompt, cancel, confirm);
      row.append(confirmation);
      cancel.focus();
    });
  }
  updateCurrentSite();
}
$("grant-site").addEventListener("click", async () => {
  if (!currentOrigin || permissionBusy) return;
  permissionBusy = true;
  updateCurrentSite();
  try {
    // Keep the request directly in the click gesture for Chrome's permission prompt.
    const granted = await chrome.permissions.request({ origins: [currentOrigin + "/*"] });
    $("site-feedback").textContent = granted ? "当前站点已授权，请确保已完成网关登录。" : "站点授权已取消。";
    await loadPermissions();
  } catch (error) { $("site-feedback").textContent = `授权失败：${error.message}`; }
  finally { permissionBusy = false; updateCurrentSite(); if ($("grant-site").hidden) $("sites-link").focus(); }
});
async function initializeSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url);
    $("current-site").textContent = url.hostname || "当前页面";
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) currentOrigin = url.origin;
  } catch { $("current-site").textContent = "无法读取当前页面"; }
  await loadPermissions();
  if (currentOrigin) {
    chrome.tabs.onRemoved.addListener(() => { void refreshBridgeTabs(); });
    chrome.tabs.onReplaced.addListener(() => { void refreshBridgeTabs(); });
    chrome.tabs.onUpdated.addListener((_id, change) => {
      if (["url", "title", "discarded", "frozen"].some(key => key in change)) void refreshBridgeTabs();
    });
  }
}
void initializeSite();
void connect();
