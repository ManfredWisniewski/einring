import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const WikiPage = lazy(() => import("./WikiPage").then((m) => ({ default: m.WikiPage })));

export const wikiModule: AppModule = {
  id: "wiki",
  hasBackend: true,
  nav: { i18nKey: "modules.wiki.nav" },
  routes: [{ path: "/wiki", Component: WikiPage }],
  i18n: { de, en },
};
