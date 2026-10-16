import { App as CapApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { OidcClient, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { config, isNative, redirectUri } from "@/config";
import { loadInstanceConfig } from "@/instance";

function buildSettings() {
  return {
    authority: config.authentikIssuer,
    client_id: config.authentikClientId,
    redirect_uri: redirectUri(),
    post_logout_redirect_uri: isNative ? config.nativeRedirectUri : window.location.origin,
    response_type: "code",
    scope: "openid profile email",
    automaticSilentRenew: !isNative,
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    stateStore: new WebStorageStateStore({ store: window.localStorage }),
  };
}

let settingsCache: ReturnType<typeof buildSettings> | undefined;
let managerPromise: Promise<UserManager> | undefined;

/** OIDC settings resolved after /api/config lands — runtime values win over baked VITE_*. */
async function resolveSettings() {
  await loadInstanceConfig();
  settingsCache ??= buildSettings();
  return settingsCache;
}

/**
 * Lazy singleton: the BFF's `/api/config` supplies the Authentik issuer/clientId for this
 * deployment, so the manager is only built after that fetch resolves. `VITE_*` env values
 * remain the fallback when the BFF is unreachable or serves no authentik config.
 */
export function getUserManager(): Promise<UserManager> {
  managerPromise ??= resolveSettings().then((s) => new UserManager(s));
  return managerPromise;
}

/**
 * Web: full-page redirect to Authentik; `/auth/callback` completes it.
 * Native: Authentik opens in the system browser (Custom Tab); Android hands `einring://auth/callback?...`
 * back to the app via `appUrlOpen`, which we feed to `signinCallback`.
 */
export async function login(returnTo = "/"): Promise<void> {
  if (!isNative) {
    await (await getUserManager()).signinRedirect({ state: { returnTo } });
    return;
  }
  const client = new OidcClient(await resolveSettings());
  const request = await client.createSigninRequest({ state: { returnTo } });
  await Browser.open({ url: request.url, presentationStyle: "popover" });
}

export async function logout(): Promise<void> {
  if (isNative) {
    await (await getUserManager()).removeUser();
    return;
  }
  await (await getUserManager()).signoutRedirect();
}

export function listenForNativeCallback(onUser: () => void): () => void {
  if (!isNative) return () => {};
  const handle = CapApp.addListener("appUrlOpen", async ({ url }) => {
    if (!url.startsWith(config.nativeRedirectUri)) return;
    await Browser.close().catch(() => {});
    await (await getUserManager()).signinCallback(url);
    onUser();
  });
  return () => void handle.then((h) => h.remove());
}
