import { useSyncExternalStore } from "react";
import { config } from "@/config";

/** Deployment whitelabel from the BFF's public /api/config (INSTANCE_* env). */
interface InstanceConfig {
  name: string;
  /** undefined = app's default tagline, "" = hidden, string = override. */
  tagline?: string;
  cssVars?: Record<string, string>;
  /** Named biti theme (INSTANCE_THEME): einring CSS var maps per color scheme. */
  theme?: { light?: Record<string, string>; dark?: Record<string, string> };
  /** Runtime OIDC client settings — preferred over the baked VITE_* values. */
  authentik?: { issuer?: string; clientId?: string };
}

const DEFAULT_NAME = "Einring";
let current: InstanceConfig = { name: DEFAULT_NAME };
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useInstanceName(): string {
  return useSyncExternalStore(
    subscribe,
    () => current.name,
    () => DEFAULT_NAME,
  );
}

/** undefined = render the i18n default tagline; "" = hide it; otherwise the override. */
export function useInstanceTagline(): string | undefined {
  return useSyncExternalStore(subscribe, () => current.tagline);
}

let inflight: Promise<void> | undefined;

/** Memoized: main.tsx kicks this off at startup; auth code awaits the same promise so the
 *  OIDC manager is always built with the resolved (runtime-first) configuration. */
export function loadInstanceConfig(): Promise<void> {
  inflight ??= doLoad();
  return inflight;
}

async function doLoad(): Promise<void> {
  try {
    const res = await fetch(`${config.apiUrl}/api/config`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const body = (await res.json()) as InstanceConfig;
      current = {
        name: body.name?.trim() || DEFAULT_NAME,
        tagline: body.tagline,
        cssVars: body.cssVars,
      };
      // Dev mode serves index.html unpatched — apply brand overrides here too.
      if (body.theme) {
        const decl = (vars?: Record<string, string>) =>
          Object.entries(vars ?? {})
            .map(([k, v]) => `${k}:${v}`)
            .join(";");
        let style = document.getElementById("einring-theme");
        if (!style) {
          style = document.createElement("style");
          style.id = "einring-theme";
          document.head.append(style);
        }
        style.textContent = `:root{${decl(body.theme.light)}}[data-theme="dark"]{${decl(body.theme.dark)}}`;
      }
      for (const [k, v] of Object.entries(body.cssVars ?? {})) {
        document.documentElement.style.setProperty(k, v);
      }
      // Runtime OIDC config wins over the build-time VITE_* values.
      if (body.authentik?.issuer) config.authentikIssuer = body.authentik.issuer;
      if (body.authentik?.clientId) config.authentikClientId = body.authentik.clientId;
      for (const cb of listeners) cb();
    }
  } catch {
    // unreachable BFF — keep the default name
  }
  document.title = current.name;
}
