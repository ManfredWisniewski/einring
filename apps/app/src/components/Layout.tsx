import { Button } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { useAuth } from "@/auth/AuthProvider";
import { InfoButton } from "./InfoButton";
import { LanguageSelect, ThemeSelect } from "./Settings";

export function Layout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{t("app.name")}</h1>
        <ThemeSelect />
        <LanguageSelect />
        <InfoButton />
        {user && (
          <Button className="btn btn--ghost" onPress={() => void logout()}>
            {t("nav.logout")}
          </Button>
        )}
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
