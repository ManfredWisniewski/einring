import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";

const AudiobookshelfPage = lazy(() =>
  import("./AudiobookshelfPage").then((m) => ({ default: m.AudiobookshelfPage })),
);

export const audiobookshelfModule: AppModule = {
  id: "audiobookshelf",
  hasBackend: true,
  nav: { i18nKey: "modules.audiobookshelf.nav" },
  routes: [{ path: "/audiobookshelf", Component: AudiobookshelfPage }],
  i18n: { de, en },
};
