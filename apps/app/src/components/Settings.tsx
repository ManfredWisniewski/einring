import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Language, supportedLanguages } from "@/i18n";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemePreference } from "@/theme/theme";

const themes: ThemePreference[] = ["system", "light", "dark"];

export function ThemeSelect() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{t("theme.label")}</Label>
      <Select value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
        <SelectTrigger id={id} aria-label={t("theme.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {themes.map((th) => (
            <SelectItem key={th} value={th}>
              {t(`theme.${th}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? "en") as Language;
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{t("language.label")}</Label>
      <Select value={current} onValueChange={(v) => void i18n.changeLanguage(v)}>
        <SelectTrigger id={id} aria-label={t("language.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {supportedLanguages.map((lng) => (
            <SelectItem key={lng} value={lng}>
              {lng.toUpperCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
