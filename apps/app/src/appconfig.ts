import { Capacitor, registerPlugin } from "@capacitor/core";
import { config } from "~/config";
import { getSessionToken, markEmbedded, setSessionToken } from "~/embedded";

export interface AppConfigPlugin {
  getApiUrl(): Promise<{ value: string | null }>;
  getUsername?(): Promise<{ value: string | null }>;
  getAppPassword?(): Promise<{ value: string | null }>;
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
    const [{ value: rawUrl }, { value: rawUser }, { value: rawPassword }] = await Promise.all([
      plugin.getApiUrl(),
      plugin.getUsername?.() ?? Promise.resolve({ value: null }),
      plugin.getAppPassword?.() ?? Promise.resolve({ value: null }),
    ]);
    const url = rawUrl ? normalizeManagedUrl(rawUrl) : "";
    if (url) config.apiUrl = url;
    const username = rawUser?.trim() ?? "";
    const appPassword = rawPassword?.trim() ?? "";
    // Credential group (FR-008): acts only when complete; an existing session wins.
    if (username && appPassword && !getSessionToken()) {
      await mintManagedSession(username, appPassword);
    }
  } catch {
    // plugin missing or restrictions unreadable — keep the build default
  }
}

/** MDM credential group → BFF-verified embedded-style session (ref. impl. bb2a5da).
 *  On failure the normal interactive path stays available. */
async function mintManagedSession(username: string, appPassword: string): Promise<void> {
  try {
    const res = await fetch(`${config.apiUrl}/api/nextcloud/managed-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginName: username, appPassword }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { status?: string; sessionToken?: string };
    if (body.status === "connected" && body.sessionToken) {
      setSessionToken(body.sessionToken);
      markEmbedded();
    }
  } catch {
    // unreachable BFF or invalid credentials — interactive login stays available
  }
}
