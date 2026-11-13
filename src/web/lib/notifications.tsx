import { navigate } from "./navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

export const notificationStorageKey = "orchard-browser-notifications";
const changed = "orchard-notifications-changed";
function enabled() {
  try { return localStorage.getItem(notificationStorageKey) === "true"; } catch { return false; }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(changed, callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener(changed, callback); };
}
function useEnabled() { return useSyncExternalStore(subscribe, enabled, () => false); }
function setEnabled(value: boolean) {
  localStorage.setItem(notificationStorageKey, String(value));
  window.dispatchEvent(new Event(changed));
}
function supported() { return typeof Notification !== "undefined" && window.isSecureContext; }

export function NotificationSettings() {
  const on = useEnabled();
  const [permission, setPermission] = useState(() => supported() ? Notification.permission : "unsupported");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const refresh = () => setPermission(supported() ? Notification.permission : "unsupported");
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const toggle = async (next: boolean) => {
    setError(""); setBusy(true);
    try {
      if (!next) { setEnabled(false); return; }
      const result = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPermission(result);
      setEnabled(result === "granted");
      if (result === "default") setError("尚未授权，可再次开启通知。");
    } catch { setError("无法保存或开启通知，请检查浏览器权限及存储设置。"); }
    finally { setBusy(false); }
  };
  const hint = permission === "unsupported" ? "当前浏览器不支持通知，或页面不在安全环境中。"
    : permission === "denied" ? "通知权限已被浏览器阻止，请在站点设置中允许通知。"
    : "Agent 回复及工作流执行结束时通知（含失败、取消）。仅对此浏览器生效，需保持平台页面打开。";
  return <section className="panel preferences-list" aria-label="通知设置">
    <div className="preference-row"><div><h2>浏览器通知</h2><p id="notification-hint">{hint}</p>{error && <p role="alert">{error}</p>}</div>
      <label className="provider-toggle" style={{ flexShrink: 0 }}>
        <input type="checkbox" aria-label="启用浏览器通知" aria-describedby="notification-hint" checked={on} disabled={busy || (!on && (permission === "unsupported" || permission === "denied"))} onChange={event => void toggle(event.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
      </label>
    </div>
  </section>;
}

/** Global listener, independent of the currently open editor or run. */
export function BrowserNotifications() {
  const on = useEnabled();
  useEffect(() => {
    if (!on || !supported() || typeof EventSource === "undefined") return;
    const source = new EventSource("/api/notifications/stream");
    source.onmessage = event => {
      try {
        const item = JSON.parse(event.data) as { id: string; key: string; title: string; body: string; url: string };
        if (!item.key || typeof item.title !== "string" || typeof item.url !== "string" || !/^\/(runs|drafts|scripts)\/[^/]+$|^\/web-bridge$/.test(item.url)) return;
        const show = () => {
          if (!enabled() || Notification.permission !== "granted") return;
          const key = "orchard-notification-delivered";
          let seen: string[] = [];
          try { seen = JSON.parse(localStorage.getItem(key) ?? "[]"); } catch {}
          if (!Array.isArray(seen)) seen = [];
          if (seen.includes(item.key)) return;
          const notification = new Notification(item.title, { body: item.body, tag: item.key });
          try { localStorage.setItem(key, JSON.stringify([...seen.slice(-99), item.key])); } catch {}
          notification.onclick = () => { window.focus(); navigate(item.url); notification.close(); };
        };
        if (navigator.locks) void navigator.locks.request("orchard-notification", show).catch(() => {});
        else show();
      } catch { /* Notification failures must not disrupt the workbench. */ }
    };
    return () => source.close();
  }, [on]);
  return null;
}
