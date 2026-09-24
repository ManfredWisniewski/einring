export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "einring.theme";

export function readPreference(storage: Pick<Storage, "getItem"> = localStorage): ThemePreference {
  const v = storage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function systemTheme(): ResolvedTheme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(
  pref: ThemePreference,
  system: ResolvedTheme = systemTheme(),
): ResolvedTheme {
  return pref === "system" ? system : pref;
}

export function applyTheme(theme: ResolvedTheme, root: HTMLElement = document.documentElement) {
  root.dataset.theme = theme;
}
