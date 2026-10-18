import { useMemo, useState } from "react";
import { Button, MenuTrigger, Popover } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import {
  useEinHubNotifications,
  useModulePrefs,
  useModuleRegistry,
  useNextcloudSettings,
} from "@/api/hooks";
import { useAuth } from "@/auth/AuthProvider";
import { buttonVariants, Button as UiButton } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useInstanceName } from "@/instance";
import { resolveAppModules } from "@/modules";
import { AppMenu } from "./AppMenu";
import { LanguageSelect, ThemeSelect } from "./Settings";

export function Layout() {
  const { t, i18n } = useTranslation();
  const name = useInstanceName();
  const { user, logout } = useAuth();
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

  // Nav filters (D53): search by name + multi-select tag dropdown; alphabetical, EinHub first.
  const [query, setQuery] = useState("");
  const [tags, setTags] = useState<Set<string>>(new Set());
  const allTags = useMemo(() => {
    const seen: string[] = [];
    for (const m of navModules) {
      const g = m.nav?.group;
      if (g && !seen.includes(g)) seen.push(g);
    }
    return seen;
  }, [navModules]);
  const q = query.trim().toLowerCase();
  const visible = navModules.filter(
    (m) =>
      (q === "" ||
        t(m.nav?.i18nKey ?? "")
          .toLowerCase()
          .includes(q)) &&
      (tags.size === 0 || tags.has(m.nav?.group ?? "")),
  );
  const sorted = [...visible].sort((a, b) => {
    if (a.id === "einhub") return -1;
    if (b.id === "einhub") return 1;
    return t(a.nav?.i18nKey ?? "").localeCompare(t(b.nav?.i18nKey ?? ""), i18n.language);
  });

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{name}</h1>
        <ThemeSelect />
        <LanguageSelect />
        <AppMenu />
        {user && (
          <UiButton variant="ghost" onClick={() => void logout()}>
            {t("nav.logout")}
          </UiButton>
        )}
      </header>
      {user && navModules.length > 0 && (
        <nav className="app-nav" aria-label={t("nav.label")}>
          <div className="app-nav__controls">
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("nav.search")}
              aria-label={t("nav.search")}
              className="app-nav__search"
            />
            <MenuTrigger>
              <Button
                className={buttonVariants({ variant: "outline", size: "sm" })}
                aria-label={t("nav.tags")}
              >
                {t("nav.tags")}
                {tags.size > 0 ? ` (${tags.size})` : ""}
              </Button>
              <Popover placement="bottom start">
                <fieldset className="app-menu--tags" aria-label={t("nav.tags")}>
                  {allTags.map((g) => (
                    <div key={g} className="app-menu__item">
                      <Checkbox
                        id={`nav-tag-${g}`}
                        checked={tags.has(g)}
                        onCheckedChange={(checked) =>
                          setTags((prev) => {
                            const next = new Set(prev);
                            if (checked === true) next.add(g);
                            else next.delete(g);
                            return next;
                          })
                        }
                      />
                      <Label htmlFor={`nav-tag-${g}`}>{t(`nav.group.${g}`)}</Label>
                    </div>
                  ))}
                </fieldset>
              </Popover>
            </MenuTrigger>
          </div>
          {sorted.length === 0 && <p className="muted app-nav__empty">{t("nav.noMatches")}</p>}
          <div className="app-nav__links">
            {sorted.map((m) => (
              <NavLink key={m.id} to={m.routes.at(0)?.path ?? "/"} className="app-nav__link">
                {t(m.nav?.i18nKey ?? "")}
                {m.id === "einhub" && unread > 0 && (
                  <span className="app-nav__badge">{unread}</span>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
