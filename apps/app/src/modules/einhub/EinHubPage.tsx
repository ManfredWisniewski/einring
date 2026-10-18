import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import {
  useEinHubMarkRead,
  useEinHubNotifications,
  useEinHubReadAll,
  useModulePrefs,
  useModuleRegistry,
} from "@/api/hooks";
import type { EinHubNotification } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** One notification row — click marks it read; "Open" jumps to the source module. */
function NotificationRow({ n, enabled }: { n: EinHubNotification; enabled: boolean }) {
  const { t } = useTranslation();
  const mark = useEinHubMarkRead();
  const moduleName = t(`modules.${n.module}.nav`, { defaultValue: n.module });
  return (
    <Card className={n.read ? undefined : "einhub-card--unread"}>
      <button
        type="button"
        className="w-full text-left"
        onClick={() => {
          if (!n.read) mark.mutate(n.id);
        }}
      >
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            {!n.read && <span className="status-dot status-dot--dnd" aria-hidden />}
            {n.title}
          </CardTitle>
          <CardDescription>
            {moduleName}
            {n.body ? ` · ${n.body}` : ""} · {new Date(n.at).toLocaleString()}
          </CardDescription>
        </CardHeader>
      </button>
      {enabled && (
        <div className="einhub-card__action">
          <Button variant="outline" size="sm" asChild>
            <Link to={`/${n.module}`}>{t("modules.einhub.open")}</Link>
          </Button>
        </div>
      )}
    </Card>
  );
}

export function EinHubPage() {
  const { t } = useTranslation();
  const feed = useEinHubNotifications();
  const readAll = useEinHubReadAll();
  const registry = useModuleRegistry();
  const enabledModules = new Set(registry.data?.modules.map((m) => m.id) ?? []);
  // User-disabled modules (D47) are filtered out of the displayed feed.
  const prefs = useModulePrefs();
  const prefDisabled = new Set(prefs.data?.disabled ?? []);
  const notifications = (feed.data?.notifications ?? []).filter((n) => !prefDisabled.has(n.module));
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="stack">
      <div className="row einhub-header">
        <h2 className="text-lg">{t("modules.einhub.title")}</h2>
        {unread > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => readAll.mutate()}
            disabled={readAll.isPending}
          >
            {t("modules.einhub.markAllRead")}
          </Button>
        )}
      </div>
      {unread > 0 && <p className="muted">{t("modules.einhub.unread", { count: unread })}</p>}
      {feed.isPending && <p className="muted">{t("common.loading")}</p>}
      {feed.isError && (
        <div className="alert alert--danger">
          {t("modules.einhub.error", {
            status: feed.error instanceof ApiError ? feed.error.status : "?",
          })}
        </div>
      )}
      {notifications.length === 0 && !feed.isPending && !feed.isError && (
        <p className="muted">
          {t("modules.einhub.empty")} {t("modules.einhub.emptyHint")}
        </p>
      )}
      {notifications.map((n) => (
        <NotificationRow key={n.id} n={n} enabled={enabledModules.has(n.module)} />
      ))}
    </div>
  );
}
