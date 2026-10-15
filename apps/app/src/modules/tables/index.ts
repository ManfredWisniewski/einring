import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const TablesPage = lazy(() => import("./TablesPage").then((m) => ({ default: m.TablesPage })));

export const tablesModule: AppModule = {
  id: "tables",
  hasBackend: true,
  nav: { i18nKey: "modules.tables.nav" },
  routes: [{ path: "/tables", Component: TablesPage }],
  i18n: { de, en },
};
