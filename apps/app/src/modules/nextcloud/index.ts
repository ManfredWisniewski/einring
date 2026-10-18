import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const NextcloudPage = lazy(() =>
  import("./NextcloudPage").then((m) => ({ default: m.NextcloudPage })),
);

export const nextcloudModule: AppModule = {
  id: "nextcloud",
  hasBackend: true,
  nav: { i18nKey: "modules.nextcloud.nav", group: "system" },
  routes: [{ path: "/nextcloud", Component: NextcloudPage }],
  i18n: { de, en, fr, ru },
};
