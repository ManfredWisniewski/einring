import { Capacitor, registerPlugin } from "@capacitor/core";
import { config } from "~/config";

export interface AppConfigPlugin {
  getApiUrl(): Promise<{ value: string | null }>;
}

/** Present only in the Android WebView — the plugin is registered natively (D54 pattern). */
const native = Capacitor.isNativePlatform() ? registerPlugin<AppConfigPlugin>("AppConfig") : null;

/** "host.tld" -> "https://host.tld"; existing schemes kept, trailing slashes stripped (A40-style). */
export function normalizeManagedUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * MDM managed configuration (spec: +wit/specs/common/android-appconfig).
 * Read once at startup — instance.ts awaits this before the first BFF request,
 * so a pushed einring_api_url overrides the baked VITE_API_URL (FR-006/FR-007).
 * Managed values are never logged (NFR-003). Unset/blank keeps the build default.
 */
export async function initManagedConfig(plugin: AppConfigPlugin | null = native): Promise<void> {
  if (!plugin) return;
  try {
    const { value } = await plugin.getApiUrl();
    const url = value ? normalizeManagedUrl(value) : "";
    if (url) config.apiUrl = url;
  } catch {
    // plugin missing or restrictions unreadable — keep the build default
  }
}
