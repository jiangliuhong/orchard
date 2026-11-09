const form = document.getElementById("profile-form");
const nameInput = document.getElementById("profile-name");
const saveButton = document.getElementById("save");
const reconnectButton = document.getElementById("reconnect");
const status = document.getElementById("status");
let refreshTimer;
let busy = false;
let closed = false;
let profileName;

const connect = async (save = false, automatic = false) => {
  if (busy || closed) return;
  busy = true;
  window.clearTimeout(refreshTimer);
  nameInput.disabled = !automatic;
  saveButton.disabled = true;
  reconnectButton.disabled = true;
  if (!automatic) {
    status.dataset.state = "";
    status.textContent = save ? "正在保存并连接…" : "正在连接本机服务…";
  }
  try {
    const result = await chrome.runtime.sendMessage(save ? { type: "profile:save", name: nameInput.value } : { type: automatic ? "profile:status" : "profile:register" });
    if (!result?.ok) throw new Error(result?.error || "无法连接插件后台，请重新加载插件后重试。");
    if (save || profileName === undefined || nameInput.value === profileName) nameInput.value = result.profile.name;
    profileName = result.profile.name;
    document.getElementById("profile-id").textContent = result.profile.id;
    document.getElementById("extension-id").textContent = result.profile.extensionId;
    document.getElementById("servers").textContent = result.servers.length ? result.servers.join("\n") : "尚未连接";
    status.dataset.state = result.servers.length ? "success" : "error";
    status.textContent = result.servers.length
      ? `${save ? "名称已保存，" : ""}已连接本机服务。请在工作台刷新浏览器资料。`
      : `${save ? "名称已保存。" : ""}尚未连接本机服务，自动重连已开启，每 30 秒重试。`;
  } catch (error) {
    status.dataset.state = "error";
    status.textContent = error.message;
  } finally {
    busy = false;
    nameInput.disabled = false;
    saveButton.disabled = false;
    reconnectButton.disabled = false;
    if (!closed) refreshTimer = window.setTimeout(() => { void connect(false, true); }, 5000);
  }
};

form.addEventListener("submit", event => {
  event.preventDefault();
  void connect(true);
});
reconnectButton.addEventListener("click", () => { void connect(); });
window.addEventListener("pagehide", () => {
  closed = true;
  window.clearTimeout(refreshTimer);
});
document.getElementById("grant-site")?.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("仅支持 HTTPS 或本机站点");
    const granted = await chrome.permissions.request({ origins: [url.origin + "/*"] });
    status.textContent = granted ? "当前站点已授权；请确保已完成网关登录。" : "站点授权已取消。";
  } catch (error) { status.textContent = error.message; }
});
void connect();
