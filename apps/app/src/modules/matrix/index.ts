import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const MatrixPage = lazy(() => import("./MatrixPage").then((m) => ({ default: m.MatrixPage })));

export const matrixModule: AppModule = {
  id: "matrix",
  hasBackend: true,
  nav: { i18nKey: "modules.matrix.nav", group: "communication" },
  routes: [{ path: "/matrix", Component: MatrixPage }],
  i18n: { de, en, fr, ru },
};
