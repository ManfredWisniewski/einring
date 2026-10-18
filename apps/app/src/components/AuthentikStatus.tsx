import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import { useAuthentikHealth } from "@/api/hooks";
import { Button } from "@/components/ui/button";

function fmt(value: string | number | null | undefined): string {
  return value == null || value === "" ? "—" : String(value);
}

/** The aggregated Authentik health snapshot (D45) — shown on /authentik and in Monitor. */
export function AuthentikStatusView() {
  const { t } = useTranslation();
  const health = useAuthentikHealth();

  if (health.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (health.isError) {
    const status = health.error instanceof ApiError ? health.error.status : "?";
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.authentik.error", { status })}</span>
        <Button variant="outline" onClick={() => void health.refetch()}>
          {t("modules.authentik.retry")}
        </Button>
      </div>
    );
  }
  const s = health.data;
  const rows: [string, string][] = [
    [t("modules.authentik.account"), s.account ? fmt(s.account.name ?? s.account.username) : "—"],
    [
      t("modules.authentik.version"),
      s.version
        ? `${fmt(s.version.current)}${
            s.version.outdated
              ? ` (${t("modules.authentik.outdated", { latest: fmt(s.version.latest) })})`
              : ""
          }`
        : "—",
    ],
    [t("modules.authentik.users"), fmt(s.counts.users)],
    [t("modules.authentik.groups"), fmt(s.counts.groups)],
    [t("modules.authentik.applications"), fmt(s.counts.applications)],
    [t("modules.authentik.outposts"), fmt(s.counts.outposts)],
    [t("modules.authentik.workers"), fmt(s.workers)],
    [
      t("modules.authentik.tasks"),
      s.tasks
        ? `${s.tasks.total} (${t("modules.authentik.tasksFailed", { count: s.tasks.failed })})`
        : "—",
    ],
    [t("modules.authentik.loginFailed"), s.events ? fmt(s.events.loginFailedTotal) : "—"],
  ];

  return (
    <div className="stack">
      <dl className="defs">
        {rows.map(([label, value]) => (
          <div key={label} className="defs__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {s.tasks && s.tasks.failedNames.length > 0 && (
        <div className="alert alert--danger">
          {t("modules.authentik.failedTasks")}: {s.tasks.failedNames.join(", ")}
        </div>
      )}
      {s.events && s.events.recent.length > 0 && (
        <ul className="status-list">
          {s.events.recent.map((e) => (
            <li key={`${e.created}-${e.action}-${e.user ?? ""}`} className="status-item">
              <span>{e.action}</span>
              {e.user && <span className="muted">{e.user}</span>}
              <time className="status-item__lastseen muted">
                {e.created ? new Date(e.created).toLocaleString() : "—"}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
