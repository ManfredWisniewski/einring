import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const GotifyPage = lazy(() => import("./GotifyPage").then((m) => ({ default: m.GotifyPage })));

export const gotifyModule: AppModule = {
  id: "gotify",
  hasBackend: true,
  nav: { i18nKey: "modules.gotify.nav", group: "communication" },
  routes: [{ path: "/gotify", Component: GotifyPage }],
  i18n: { de, en, fr, ru },
};
