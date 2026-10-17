import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const CsvManagerPage = lazy(() =>
  import("./CsvManagerPage").then((m) => ({ default: m.CsvManagerPage })),
);

export const csvManagerModule: AppModule = {
  id: "csv-manager",
  hasBackend: true,
  nav: { i18nKey: "modules.csv-manager.nav" },
  routes: [{ path: "/csv-manager", Component: CsvManagerPage }],
  i18n: { de, en },
};
