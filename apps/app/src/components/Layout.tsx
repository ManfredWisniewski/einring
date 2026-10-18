import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";
import {
  useEinHubNotifications,
  useModulePrefs,
  useModuleRegistry,
  useNextcloudSettings,
} from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInstanceName } from "@/instance";
import { resolveAppModules } from "@/modules";
import type { AppModule } from "@/modules/types";
import { AppMenu } from "./AppMenu";
import { LanguageSelect, ThemeSelect } from "./Settings";

export function Layout() {
  const { t } = useTranslation();
  const name = useInstanceName();
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const registry = useModuleRegistry(!!user);
  // Per-user Nextcloud feature toggles (D46) hide whole modules from the nav.
  const ncSettings = useNextcloudSettings(!!user);
  // Per-user module activation (D47) hides them too.
  const prefs = useModulePrefs(!!user);
  const navModules = useMemo(() => {
    const hiddenByNc = new Set(
      (["tables", "wiki"] as const).filter((id) => ncSettings.data?.settings[id] === false),
    );
    const prefDisabled = new Set(prefs.data?.disabled ?? []);
    return resolveAppModules(registry.data?.modules).filter(
      (m) =>
        m.nav != null &&
        m.routes.length > 0 &&
        !hiddenByNc.has(m.id as "tables" | "wiki") &&
        !prefDisabled.has(m.id),
    );
  }, [registry.data?.modules, ncSettings.data?.settings, prefs.data?.disabled]);
  // Global hub poll: the unread badge updates no matter which page is open.
  const einhubOn = registry.data?.modules.some((m) => m.id === "einhub") ?? false;
  const hub = useEinHubNotifications(!!user && einhubOn);
  const unread = hub.data?.unread ?? 0;

  // Accordion nav (D53): one group open at a time, search expands all matches.
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const matches = (m: AppModule) =>
    !searching ||
    t(m.nav?.i18nKey ?? "")
      .toLowerCase()
      .includes(query.trim().toLowerCase());
  const visible = navModules.filter(matches);
  const groups: { group: string; modules: AppModule[] }[] = [];
  for (const m of visible) {
    const g = m.nav?.group ?? "";
    const last = groups.at(-1);
    if (last && last.group === g) last.modules.push(m);
    else groups.push({ group: g, modules: [m] });
  }

  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const g = navModules.find((m) => m.routes.some((r) => pathname.startsWith(r.path)))?.nav?.group;
    if (g) setOpen(g);
  }, [pathname, navModules]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{name}</h1>
        <ThemeSelect />
        <LanguageSelect />
        <AppMenu />
        {user && (
          <Button variant="ghost" onClick={() => void logout()}>
            {t("nav.logout")}
          </Button>
        )}
      </header>
      {user && navModules.length > 0 && (
        <nav className="app-nav" aria-label={t("nav.label")}>
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={t("nav.search")}
            aria-label={t("nav.search")}
            className="app-nav__search"
          />
          {groups.length === 0 && <p className="muted app-nav__empty">{t("nav.noMatches")}</p>}
          {groups.map(({ group, modules }) => {
            const expanded = searching || open === group;
            return (
              <section key={group} className="app-nav__group">
                <button
                  type="button"
                  className="app-nav__grouptitle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded && !searching ? null : group)}
                >
                  <span className="app-nav__chevron" aria-hidden>
                    {expanded ? "▾" : "▸"}
                  </span>
                  {t(`nav.group.${group}`)}
                  <span className="muted">({modules.length})</span>
                </button>
                {expanded && (
                  <div className="app-nav__links">
                    {modules.map((m) => (
                      <NavLink
                        key={m.id}
                        to={m.routes.at(0)?.path ?? "/"}
                        className="app-nav__link"
                      >
                        {t(m.nav?.i18nKey ?? "")}
                        {m.id === "einhub" && unread > 0 && (
                          <span className="app-nav__badge">{unread}</span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </nav>
      )}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
