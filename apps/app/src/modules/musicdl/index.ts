import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const MusicDlPage = lazy(() => import("./MusicDlPage").then((m) => ({ default: m.MusicDlPage })));

export const musicdlModule: AppModule = {
  id: "musicdl",
  hasBackend: true,
  nav: { i18nKey: "modules.musicdl.nav", group: "media" },
  routes: [{ path: "/musicdl", Component: MusicDlPage }],
  i18n: { de, en },
};
