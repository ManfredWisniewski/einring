import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EinpillPage = lazy(() => import("./EinpillPage").then((m) => ({ default: m.EinpillPage })));

export const einpillModule: AppModule = {
  id: "einpill",
  hasBackend: true,
  nav: { i18nKey: "modules.einpill.nav", group: "core" },
  routes: [{ path: "/einpill", Component: EinpillPage }],
  i18n: { de, en, fr, ru },
};
