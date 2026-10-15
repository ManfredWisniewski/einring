import { useSyncExternalStore } from "react";
import { config } from "@/config";

/** Deployment whitelabel from the BFF's public /api/config (INSTANCE_* env). */
interface InstanceConfig {
  name: string;
  /** undefined = app's default tagline, "" = hidden, string = override. */
  tagline?: string;
  cssVars?: Record<string, string>;
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

export async function loadInstanceConfig(): Promise<void> {
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
      for (const [k, v] of Object.entries(body.cssVars ?? {})) {
        document.documentElement.style.setProperty(k, v);
      }
      for (const cb of listeners) cb();
    }
  } catch {
    // unreachable BFF — keep the default name
  }
  document.title = current.name;
}
