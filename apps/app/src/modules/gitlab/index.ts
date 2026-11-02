import { lazy } from "react";
import { connectorSettings } from "@/components/ConnectorPage";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const GitLabPage = lazy(() => import("./GitLabPage").then((m) => ({ default: m.GitLabPage })));

export const gitlabModule: AppModule = {
  id: "gitlab",
  hasBackend: true,
  nav: { i18nKey: "modules.gitlab.nav", group: "integrations" },
  settings: connectorSettings("gitlab"),
  routes: [{ path: "/gitlab", Component: GitLabPage }],
  i18n: { de, en, fr, ru },
};
