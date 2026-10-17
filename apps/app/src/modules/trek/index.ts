import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const TrekPage = lazy(() => import("./TrekPage").then((m) => ({ default: m.TrekPage })));

export const trekModule: AppModule = {
  id: "trek",
  hasBackend: true,
  nav: { i18nKey: "modules.trek.nav" },
  routes: [{ path: "/trek", Component: TrekPage }],
  i18n: { de, en },
};
