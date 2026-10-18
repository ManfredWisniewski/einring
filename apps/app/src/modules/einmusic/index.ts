import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const EinMusicPage = lazy(() =>
  import("./EinMusicPage").then((m) => ({ default: m.EinMusicPage })),
);

export const einmusicModule: AppModule = {
  id: "einmusic",
  hasBackend: true,
  nav: { i18nKey: "modules.einmusic.nav", group: "media" },
  routes: [{ path: "/einmusic", Component: EinMusicPage }],
  i18n: { de, en, fr, ru },
};
