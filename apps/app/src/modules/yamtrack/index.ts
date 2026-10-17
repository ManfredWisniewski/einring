import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const YamtrackPage = lazy(() =>
  import("./YamtrackPage").then((m) => ({ default: m.YamtrackPage })),
);

export const yamtrackModule: AppModule = {
  id: "yamtrack",
  hasBackend: true,
  nav: { i18nKey: "modules.yamtrack.nav" },
  routes: [{ path: "/yamtrack", Component: YamtrackPage }],
  i18n: { de, en },
};
