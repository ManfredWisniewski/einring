import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

const env = import.meta.env;

export const config = {
  /** Build-time fallbacks — the BFF's `/api/config` overrides these at runtime (see instance.ts). */
  authentikIssuer: env.VITE_AUTHENTIK_ISSUER as string,
  authentikClientId: env.VITE_AUTHENTIK_CLIENT_ID as string,
  /** Empty string = same origin (browser). Android builds need the full BFF URL. */
  apiUrl: ((env.VITE_API_URL as string | undefined) ?? "").replace(/\/+$/, ""),
  /** Custom scheme the Android app is registered for; web uses an https callback route.
   *  Variant builds override it via VITE_REDIRECT_SCHEME + a matching manifest intent-filter. */
  nativeRedirectUri: `${(env.VITE_REDIRECT_SCHEME as string | undefined) ?? "einring"}://auth/callback`,
  webRedirectPath: "/auth/callback",
  /** Build-time module allowlist (VITE_MODULES csv) — intersected with the BFF registry
   *  in modules/index.ts; undefined = no app-side restriction. */
  modules: (env.VITE_MODULES as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

export function redirectUri(): string {
  return isNative ? config.nativeRedirectUri : `${window.location.origin}${config.webRedirectPath}`;
}

/** Evaluated lazily — runtime config from /api/config may fill gaps left by missing VITE_* vars. */
export function missingAuthConfig(): string[] {
  return (["authentikIssuer", "authentikClientId"] as const).filter((k) => !config[k]);
}
