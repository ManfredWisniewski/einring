import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const AuthentikPage = lazy(() =>
  import("./AuthentikPage").then((m) => ({ default: m.AuthentikPage })),
);

export const authentikModule: AppModule = {
  id: "authentik",
  hasBackend: true,
  nav: { i18nKey: "modules.authentik.nav", group: "system" },
  routes: [{ path: "/authentik", Component: AuthentikPage }],
  i18n: { de, en, fr, ru },
};
