import { lazy } from "react";
import { connectorSettings } from "~/components/ConnectorPage";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const ItsaplanPage = lazy(() =>
  import("./ItsaplanPage").then((m) => ({ default: m.ItsaplanPage })),
);

export const itsaplanModule: AppModule = {
  id: "itsaplan",
  hasBackend: true,
  nav: { i18nKey: "modules.itsaplan.nav", group: "integrations" },
  settings: connectorSettings("itsaplan"),
  routes: [{ path: "/itsaplan", Component: ItsaplanPage }],
  i18n: { de, en, fr, ru },
};
