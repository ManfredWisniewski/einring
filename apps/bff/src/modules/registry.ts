import type { Config } from "../config.js";
import { monitorModule } from "./monitor.js";
import { tablesModule } from "./tables.js";
import type { BffModule } from "./types.js";

/** All modules known to the BFF. App-only modules (no backend part) don't appear here. */
export const bffModules: BffModule[] = [tablesModule, monitorModule];

/** `MODULE_<ID>_` env prefix for a module id (`monitor-hub` → `MODULE_MONITOR_HUB_`). */
function envPrefix(id: string): string {
  return `MODULE_${id.toUpperCase().replaceAll("-", "_")}_`;
}

/** A module paired with its validated env config. */
export interface ResolvedModule {
  module: BffModule;
  config: unknown;
}

/**
 * Enabled modules with parsed config. MODULES env absent = all registered;
 * otherwise exactly the listed ids. Invalid config of an enabled module throws (fail fast).
 */
export function resolveModules(config: Config): ResolvedModule[] {
  const wanted = config.modules;
  if (wanted) {
    const known = new Set(bffModules.map((m) => m.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length) {
      throw new Error(`Unknown modules in MODULES: ${unknown.join(", ")}`);
    }
  }
  return bffModules
    .filter((m) => !wanted || wanted.includes(m.id))
    .map((module) => {
      if (!module.configSchema) return { module, config: undefined };
      const prefix = envPrefix(module.id);
      const env = Object.fromEntries(
        Object.entries(config.moduleEnv)
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => [k.slice(prefix.length), v]),
      );
      const parsed = module.configSchema.safeParse(env);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
        throw new Error(`Invalid config for module "${module.id}":\n${issues.join("\n")}`);
      }
      return { module, config: parsed.data };
    });
}
