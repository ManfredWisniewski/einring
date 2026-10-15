import { Button } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { useModuleRegistry } from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { useInstanceName } from "@/instance";
import { resolveAppModules } from "@/modules";
import { InfoButton } from "./InfoButton";
import { LanguageSelect, ThemeSelect } from "./Settings";

export function Layout() {
  const { t } = useTranslation();
  const name = useInstanceName();
  const { user, logout } = useAuth();
  const registry = useModuleRegistry(!!user);
  const navModules = resolveAppModules(registry.data?.modules).filter(
    (m) => m.nav != null && m.routes.length > 0,
  );
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{name}</h1>
        <ThemeSelect />
        <LanguageSelect />
        <InfoButton />
        {user && (
          <Button className="btn btn--ghost" onPress={() => void logout()}>
            {t("nav.logout")}
          </Button>
        )}
      </header>
      {user && navModules.length > 0 && (
        <nav className="app-nav" aria-label={t("nav.label")}>
          {navModules.map((m) => (
            <NavLink key={m.id} to={m.routes.at(0)?.path ?? "/"} className="app-nav__link">
              {t(m.nav?.i18nKey ?? "")}
            </NavLink>
          ))}
        </nav>
      )}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
