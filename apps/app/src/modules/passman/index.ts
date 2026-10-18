import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const PassmanPage = lazy(() => import("./PassmanPage").then((m) => ({ default: m.PassmanPage })));

export const passmanModule: AppModule = {
  id: "passman",
  hasBackend: true,
  nav: { i18nKey: "modules.passman.nav", group: "data" },
  routes: [{ path: "/passman", Component: PassmanPage }],
  i18n: { de, en, fr, ru },
};
