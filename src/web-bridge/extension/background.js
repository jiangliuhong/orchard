const registerProfile = async () => {
  const profile = { id: chrome.runtime.id, name: `Chrome · ${chrome.runtime.id.slice(-6)}`, extensionId: chrome.runtime.id };
  for (const port of [7441, 7443]) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/web-bridge/profiles/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      return;
    } catch {}
  }
};
void registerProfile();
chrome.runtime.onConnectNative?.addListener(() => { void registerProfile(); });
