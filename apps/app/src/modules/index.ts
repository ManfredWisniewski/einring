import type { ModuleInfo } from "@/api/types";
import { monitorModule } from "./monitor";
import { tablesModule } from "./tables";
import type { AppModule } from "./types";

export type { AppModule, ModuleRoute } from "./types";

/** All modules bundled in the app. Frontend-only modules never need a BFF counterpart. */
export const appModules: AppModule[] = [tablesModule, monitorModule];

/**
 * Active modules for this deployment: frontend-only modules are always active,
 * backend modules only when listed by the BFF registry (its MODULES env is the source of truth).
 */
export function resolveAppModules(registry?: ModuleInfo[]): AppModule[] {
  const enabled = new Set(registry?.map((m) => m.id) ?? []);
  return appModules.filter((m) => !m.hasBackend || enabled.has(m.id));
}

/** `modules.<id>` translation subtree for one language, across all bundled modules. */
export function moduleTranslations(lang: "de" | "en"): Record<string, unknown> {
  return Object.fromEntries(appModules.map((m) => [m.id, m.i18n?.[lang] ?? {}]));
}
