import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EinDavPage = lazy(() => import("./EinDavPage"));

export const eindavModule: AppModule = {
  id: "eindav",
  hasBackend: true,
  nav: { i18nKey: "modules.eindav.nav", group: "data" },
  routes: [{ path: "/eindav", Component: EinDavPage }],
  i18n: { de, en, fr, ru },
};
