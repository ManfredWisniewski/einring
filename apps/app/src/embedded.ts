/**
 * Embedded mode: einring runs inside a Nextcloud "External sites" iframe, entered via
 * `?embedded=nextcloud` on the app URL. Authentik login is skipped — completing
 * Nextcloud Login Flow v2 mints an einring session token instead (D19 amendment).
 *
 * The flag persists in sessionStorage because SPA navigation drops the query param
 * (sessionStorage is per-tab and partitioned per top-level site, so an embedded tab
 * cannot leak the flag into a standalone one). The session token lives in
 * localStorage so it survives iframe reloads.
 */

const EMBEDDED_KEY = "einring.embedded";
const SESSION_KEY = "einring.session";

let embeddedCache: boolean | undefined;

export function isEmbedded(): boolean {
  if (embeddedCache !== undefined) return embeddedCache;
  try {
    if (new URLSearchParams(window.location.search).get("embedded") === "nextcloud") {
      sessionStorage.setItem(EMBEDDED_KEY, "1");
    }
    embeddedCache = sessionStorage.getItem(EMBEDDED_KEY) === "1";
  } catch {
    embeddedCache = false;
  }
  return embeddedCache;
}

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string): void {
  localStorage.setItem(SESSION_KEY, token);
}

export function clearSessionToken(): void {
  localStorage.removeItem(SESSION_KEY);
}
