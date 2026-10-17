import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EinHubPage = lazy(() => import("./EinHubPage").then((m) => ({ default: m.EinHubPage })));

export const einhubModule: AppModule = {
  id: "einhub",
  hasBackend: true,
  nav: { i18nKey: "modules.einhub.nav" },
  routes: [{ path: "/einhub", Component: EinHubPage }],
  i18n: { de, en, fr, ru },
};
