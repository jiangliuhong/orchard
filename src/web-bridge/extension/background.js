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
        if (response.ok) servers.push(`http://127.0.0.1:${port}`);
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
