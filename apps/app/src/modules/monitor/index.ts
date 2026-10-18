import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const MonitorPage = lazy(() => import("./MonitorPage").then((m) => ({ default: m.MonitorPage })));

export const monitorModule: AppModule = {
  id: "monitor",
  hasBackend: true,
  nav: { i18nKey: "modules.monitor.nav", group: "system" },
  routes: [{ path: "/monitor", Component: MonitorPage }],
  i18n: { de, en, fr, ru },
};
