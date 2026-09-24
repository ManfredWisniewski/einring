import { App as CapApp } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { OidcClient, UserManager, WebStorageStateStore } from "oidc-client-ts";
import { config, isNative, redirectUri } from "@/config";

const settings = {
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

export const userManager = new UserManager(settings);

/**
 * Web: full-page redirect to Authentik; `/auth/callback` completes it.
 * Native: Authentik opens in the system browser (Custom Tab); Android hands `einring://auth/callback?...`
 * back to the app via `appUrlOpen`, which we feed to `signinCallback`.
 */
export async function login(returnTo = "/"): Promise<void> {
  if (!isNative) {
    await userManager.signinRedirect({ state: { returnTo } });
    return;
  }
  const client = new OidcClient(settings);
  const request = await client.createSigninRequest({ state: { returnTo } });
  await Browser.open({ url: request.url, presentationStyle: "popover" });
}

export async function logout(): Promise<void> {
  if (isNative) {
    await userManager.removeUser();
    return;
  }
  await userManager.signoutRedirect();
}

export function listenForNativeCallback(onUser: () => void): () => void {
  if (!isNative) return () => {};
  const handle = CapApp.addListener("appUrlOpen", async ({ url }) => {
    if (!url.startsWith(config.nativeRedirectUri)) return;
    await Browser.close().catch(() => {});
    await userManager.signinCallback(url);
    onUser();
  });
  return () => void handle.then((h) => h.remove());
}
