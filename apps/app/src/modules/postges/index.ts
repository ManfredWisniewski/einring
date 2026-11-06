import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const PostgesPage = lazy(() => import("./PostgesPage").then((m) => ({ default: m.PostgesPage })));

export const postgesModule: AppModule = {
  id: "postges",
  hasBackend: true,
  nav: { i18nKey: "modules.postges.nav", group: "system" },
  routes: [{ path: "/postges", Component: PostgesPage }],
  i18n: { de, en, fr, ru },
};
