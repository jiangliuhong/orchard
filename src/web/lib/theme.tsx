import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

export type Theme = "light" | "dark" | "system";
export const themeStorageKey = "orchard-workbench-theme";
const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark" || value === "system";

function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(themeStorageKey);
    return isTheme(value) ? value : "system";
  } catch { return "system"; }
}

export const preferenceStorageKey = "orchard-browser-preference";
export interface PreferenceReceipt { decision: "apply" | "keep"; revision: number; force: boolean }
interface BrowserPreference { clientId: string; preferenceRevision: number; theme: Theme; consumed: Record<string, PreferenceReceipt> }
function savedPreference(): BrowserPreference {
  try {
    const raw = JSON.parse(localStorage.getItem(preferenceStorageKey) ?? "null") as BrowserPreference | null;
    if (raw?.clientId && Number.isSafeInteger(raw.preferenceRevision) && isTheme(raw.theme)) return { ...raw, consumed: raw.consumed ?? {} };
  } catch {}
  return { clientId: crypto.randomUUID(), preferenceRevision: 0, theme: savedTheme(), consumed: {} };
}
const ThemeContext = createContext({
  clientId: "",
  preferenceRevision: 0,
  getPreference: (): BrowserPreference => ({ clientId: "", preferenceRevision: 0, theme: "system", consumed: {} }),
  consumePreference: (_id: string, _decision: "apply" | "keep", _theme: Theme, _force: boolean): PreferenceReceipt => { throw new Error("ThemeProvider is required"); },
  theme: "system" as Theme,
  resolvedTheme: "light" as "light" | "dark",
  setTheme: (_theme: Theme) => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<BrowserPreference>(savedPreference);
  const current = useRef(preference);
  const theme = preference.theme;
  const install = (value: BrowserPreference) => {
    // Persist the receipt and preference together before applying or acknowledging.
    localStorage.setItem(preferenceStorageKey, JSON.stringify(value));
    current.current = value;
    setPreference(value);
    try { localStorage.setItem(themeStorageKey, value.theme); } catch {}
  };
  useEffect(() => { try { localStorage.setItem(preferenceStorageKey, JSON.stringify(current.current)); } catch {} }, []);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const resolvedTheme = theme === "system" ? systemDark ? "dark" : "light" : theme;

  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const changed = () => setSystemDark(media.matches);
    changed();
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === preferenceStorageKey && event.newValue) {
        const value = savedPreference(); current.current = value; setPreference(value);
      } else if (event.key === themeStorageKey) {
        const value = isTheme(event.newValue) ? event.newValue : "system";
        // The preference event normally precedes its mirrored legacy theme event.
        if (current.current.theme !== value) setTheme(value);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  const setTheme = (value: Theme) => {
    const previous = current.current;
    if (previous.theme === value) return;
    const next = { ...previous, theme: value, preferenceRevision: previous.preferenceRevision + 1 };
    try { install(next); } catch { current.current = next; setPreference(next); }
  };
  const consumePreference = (id: string, decision: "apply" | "keep", value: Theme, force: boolean): PreferenceReceipt => {
    const previous = current.current;
    if (previous.consumed[id]) return previous.consumed[id];
    const receipt = { decision, revision: previous.preferenceRevision, force };
    install({ ...previous, theme: decision === "apply" ? value : previous.theme,
      preferenceRevision: previous.preferenceRevision + (decision === "apply" && previous.theme !== value ? 1 : 0),
      consumed: { ...previous.consumed, [id]: receipt } });
    return receipt;
  };
  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, clientId: preference.clientId, preferenceRevision: preference.preferenceRevision, getPreference: () => current.current, consumePreference }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export function ThemePicker({ label = "外观" }: { label?: string }) {
  const { theme, setTheme } = useTheme();
  const Icon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return <div className="theme-picker">
    <Icon size={14} aria-hidden="true" />
    <select aria-label={label} value={theme} onChange={event => setTheme(event.target.value as Theme)}>
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">深色</option>
    </select>
  </div>;
}
