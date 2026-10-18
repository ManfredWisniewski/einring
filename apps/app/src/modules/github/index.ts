import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const GitHubPage = lazy(() => import("./GitHubPage").then((m) => ({ default: m.GitHubPage })));

export const githubModule: AppModule = {
  id: "github",
  hasBackend: true,
  nav: { i18nKey: "modules.github.nav", group: "integrations" },
  routes: [{ path: "/github", Component: GitHubPage }],
  i18n: { de, en, fr, ru },
};
