import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import {
  applyTheme,
  type ResolvedTheme,
  readPreference,
  resolveTheme,
  systemTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (p: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [system, setSystem] = useState<ResolvedTheme>(() => systemTheme());

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(preference, system);
  useEffect(() => applyTheme(resolved), [resolved]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    if (p === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, p);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
