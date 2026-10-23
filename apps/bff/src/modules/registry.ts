import type { Config } from "../config.js";
import { audiobookshelfModule } from "./audiobookshelf.js";
import { authentikModule } from "./authentik.js";
import { csvManagerModule } from "./csv-manager.js";
import { einchatModule } from "./einchat.js";
import { eindavModule } from "./eindav.js";
import { einhubModule } from "./einhub.js";
import { einmusicModule } from "./einmusic.js";
import { emailModule } from "./email.js";
import { githubModule } from "./github.js";
import { gitlabModule } from "./gitlab.js";
import { gotifyModule } from "./gotify.js";
import { matrixModule } from "./matrix.js";
import { monitorModule } from "./monitor.js";
import { navidromeModule } from "./navidrome.js";
import { nextcloudModule } from "./nextcloud.js";
import { passmanModule } from "./passman.js";
import { recipesModule } from "./recipes.js";
import { schoolModule } from "./school.js";
import { settingsModule } from "./settings.js";
import { tablesModule } from "./tables.js";
import { talkModule } from "./talk.js";
import { trekModule } from "./trek.js";
import type { BffModule } from "./types.js";
import { wikiModule } from "./wiki.js";
import { yamtrackModule } from "./yamtrack.js";

/** All modules known to the BFF. App-only modules (no backend part) don't appear here. */
export const bffModules: BffModule[] = [
  einhubModule,
  tablesModule,
  monitorModule,
  wikiModule,
  csvManagerModule,
  einchatModule,
  yamtrackModule,
  audiobookshelfModule,
  navidromeModule,
  einmusicModule,
  trekModule,
  emailModule,
  gotifyModule,
  gitlabModule,
  githubModule,
  authentikModule,
  nextcloudModule,
  settingsModule,
  passmanModule,
  talkModule,
  matrixModule,
  eindavModule,
  recipesModule,
  schoolModule,
];

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
