import { lazy } from "react";
import type { AppModule } from "../types";
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import fr from "./i18n/fr.json";
import ru from "./i18n/ru.json";

const PdfPage = lazy(() => import("./PdfPage").then((m) => ({ default: m.PdfPage })));

/** Frontend-only PDF viewer — no BFF counterpart (D49). */
export const pdfModule: AppModule = {
  id: "pdf",
  nav: { i18nKey: "modules.pdf.nav", group: "data" },
  routes: [{ path: "/pdf", Component: PdfPage }],
  i18n: { de, en, fr, ru },
};
