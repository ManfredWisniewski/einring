import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const TalkPage = lazy(() => import("./TalkPage").then((m) => ({ default: m.TalkPage })));

export const talkModule: AppModule = {
  id: "talk",
  hasBackend: true,
  nav: { i18nKey: "modules.talk.nav", group: "communication" },
  routes: [{ path: "/talk", Component: TalkPage }],
  i18n: { de, en, fr, ru },
};
