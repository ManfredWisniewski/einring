import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const AufmassPage = lazy(() => import("./AufmassPage").then((m) => ({ default: m.AufmassPage })));

export const aufmassModule: AppModule = {
  id: "aufmass",
  hasBackend: true,
  nav: { i18nKey: "modules.aufmass.nav", group: "data" },
  routes: [{ path: "/aufmass", Component: AufmassPage }],
  i18n: { de, en, fr, ru },
};
