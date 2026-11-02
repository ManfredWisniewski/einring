import { lazy } from "react";
import { connectorSettings } from "@/components/ConnectorPage";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const TrekPage = lazy(() => import("./TrekPage").then((m) => ({ default: m.TrekPage })));

export const trekModule: AppModule = {
  id: "trek",
  hasBackend: true,
  nav: { i18nKey: "modules.trek.nav", group: "integrations" },
  settings: connectorSettings("trek"),
  routes: [{ path: "/trek", Component: TrekPage }],
  i18n: { de, en, fr, ru },
};
