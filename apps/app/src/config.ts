import { Capacitor } from "@capacitor/core";

export const isNative = Capacitor.isNativePlatform();

const env = import.meta.env;

export const config = {
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

export const missingConfig = (["authentikIssuer", "authentikClientId"] as const).filter(
  (k) => !config[k],
);
