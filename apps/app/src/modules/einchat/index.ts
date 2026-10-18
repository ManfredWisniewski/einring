import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EinChatPage = lazy(() => import("./EinChatPage").then((m) => ({ default: m.EinChatPage })));

export const einchatModule: AppModule = {
  id: "einchat",
  hasBackend: true,
  nav: { i18nKey: "modules.einchat.nav", group: "core" },
  routes: [{ path: "/einchat", Component: EinChatPage }],
  i18n: { de, en, fr, ru },
};
