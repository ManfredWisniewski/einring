import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { moduleTranslations } from "@/modules";
import de from "./locales/de.json";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import ru from "./locales/ru.json";

export const supportedLanguages = ["de", "en", "ru", "fr"] as const;
export type Language = (typeof supportedLanguages)[number];

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      // Core `modules.*` keys (none/error/retry) win over module ids in case of a clash.
      de: { translation: { ...de, modules: { ...moduleTranslations("de"), ...de.modules } } },
      en: { translation: { ...en, modules: { ...moduleTranslations("en"), ...en.modules } } },
      ru: { translation: { ...ru, modules: { ...moduleTranslations("ru"), ...ru.modules } } },
      fr: { translation: { ...fr, modules: { ...moduleTranslations("fr"), ...fr.modules } } },
    },
    supportedLngs: supportedLanguages,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "einring.language",
      caches: ["localStorage"],
    },
  });

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
