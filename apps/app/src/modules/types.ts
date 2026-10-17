import type { ComponentType, LazyExoticComponent } from "react";

export interface ModuleRoute {
  /** Absolute route path, e.g. "/tables". First route of the first nav module is the app index. */
  path: string;
  Component: LazyExoticComponent<ComponentType>;
}

/**
 * App half of a module (D32–D35). Modules are bundled; `hasBackend` modules are
 * enabled via the BFF's `GET /api/modules` registry, frontend-only modules are always active.
 */
export interface AppModule {
  /** Stable id; must match the BFF module id when `hasBackend` is set. */
  id: string;
  /** Module consumes `/api/<id>/*` and is gated by the BFF registry. */
  hasBackend?: boolean;
  /** Navigation entry; `i18nKey` is absolute, convention `modules.<id>.nav`. */
  nav?: { i18nKey: string };
  routes: ModuleRoute[];
  /** Locale bundles merged under `modules.<id>` in the default namespace. */
  i18n?: Partial<Record<"de" | "en" | "ru" | "fr", Record<string, unknown>>>;
}
