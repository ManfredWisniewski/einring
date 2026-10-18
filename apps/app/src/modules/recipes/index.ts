import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const RecipesPage = lazy(() => import("./RecipesPage"));

export const recipesModule: AppModule = {
  id: "recipes",
  hasBackend: true,
  nav: { i18nKey: "modules.recipes.nav", group: "data" },
  routes: [{ path: "/recipes", Component: RecipesPage }],
  i18n: { de, en, fr, ru },
};
