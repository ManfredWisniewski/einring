import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

const env = import.meta.env;

export const config = {
  /** Build-time fallbacks — the BFF's `/api/config` overrides these at runtime (see instance.ts). */
  authentikIssuer: env.VITE_AUTHENTIK_ISSUER as string,
  authentikClientId: env.VITE_AUTHENTIK_CLIENT_ID as string,
  /** Empty string = same origin (browser). Android builds need the full BFF URL. */
  apiUrl: ((env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, ""),
  /** Custom scheme the Android app is registered for; web uses an https callback route. */
  nativeRedirectUri: "einring://auth/callback",
  webRedirectPath: "/auth/callback",
};

export function redirectUri(): string {
  return isNative ? config.nativeRedirectUri : `${window.location.origin}${config.webRedirectPath}`;
}

/** Evaluated lazily — runtime config from /api/config may fill gaps left by missing VITE_* vars. */
export function missingAuthConfig(): string[] {
  return (["authentikIssuer", "authentikClientId"] as const).filter((k) => !config[k]);
}
