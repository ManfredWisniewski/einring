import { lazy } from "react";
import type { AppModule } from "../types";
import { EintimeSettings } from "./EintimeSettings";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EintimePage = lazy(() => import("./EintimePage").then((m) => ({ default: m.EintimePage })));

export const eintimeModule: AppModule = {
  id: "eintime",
  hasBackend: true,
  nav: { i18nKey: "modules.eintime.nav", group: "core" },
  settings: EintimeSettings,
  routes: [{ path: "/eintime", Component: EintimePage }],
  i18n: { de, en, fr, ru },
};
