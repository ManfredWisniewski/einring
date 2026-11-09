import { lazy } from "react";
import { connectorSettings } from "~/components/ConnectorPage";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const StalwartPage = lazy(() =>
  import("./StalwartPage").then((m) => ({ default: m.StalwartPage })),
);

export const stalwartModule: AppModule = {
  id: "stalwart",
  hasBackend: true,
  nav: { i18nKey: "modules.stalwart.nav", group: "system" },
  settings: connectorSettings("stalwart", true),
  routes: [{ path: "/stalwart", Component: StalwartPage }],
  i18n: { de, en, fr, ru },
};
