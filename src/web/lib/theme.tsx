import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
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

const ThemeContext = createContext({
  theme: "system" as Theme,
  resolvedTheme: "light" as "light" | "dark",
  setTheme: (_theme: Theme) => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setPreference] = useState<Theme>(savedTheme);
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
      if (event.key === themeStorageKey) setPreference(isTheme(event.newValue) ? event.newValue : "system");
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  const setTheme = (value: Theme) => {
    setPreference(value);
    try { localStorage.setItem(themeStorageKey, value); } catch {}
  };
  return <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext.Provider>;
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
