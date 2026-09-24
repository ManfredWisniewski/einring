import {
  Button,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select,
  SelectValue,
} from "react-aria-components";
import { useTranslation } from "react-i18next";
import { type Language, supportedLanguages } from "@/i18n";
import { useTheme } from "@/theme/ThemeProvider";
import type { ThemePreference } from "@/theme/theme";

const themes: ThemePreference[] = ["system", "light", "dark"];

export function ThemeSelect() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  return (
    <Select
      className="select"
      selectedKey={preference}
      onSelectionChange={(k) => setPreference(k as ThemePreference)}
      aria-label={t("theme.label")}
    >
      <Label>{t("theme.label")}</Label>
      <Button className="btn">
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          {themes.map((th) => (
            <ListBoxItem key={th} id={th}>
              {t(`theme.${th}`)}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

export function LanguageSelect() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ?? "en") as Language;
  return (
    <Select
      className="select"
      selectedKey={current}
      onSelectionChange={(k) => void i18n.changeLanguage(String(k))}
      aria-label={t("language.label")}
    >
      <Label>{t("language.label")}</Label>
      <Button className="btn">
        <SelectValue />
      </Button>
      <Popover>
        <ListBox>
          {supportedLanguages.map((lng) => (
            <ListBoxItem key={lng} id={lng}>
              {lng.toUpperCase()}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}
