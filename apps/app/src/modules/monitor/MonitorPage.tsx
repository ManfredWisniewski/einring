import { useId, useMemo, useState } from "react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError } from "@/api/client";
import {
  useConnectorStatus,
  useModulePrefs,
  useModuleRegistry,
  useNextcloudSettings,
  useServerHealth,
  useTalkStatus,
} from "@/api/hooks";
import type { ServerBasics } from "@/api/types";
import { AuthentikStatusView } from "@/components/AuthentikStatus";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function MonitorPage() {
  const { t } = useTranslation();
  const registry = useModuleRegistry();
  // Per-user feature toggles (D46): which Nextcloud-backed monitor sections show.
  const ncSettings = useNextcloudSettings();
  const showTalk = ncSettings.data?.settings.monitorTalk !== false;
  const showServer = ncSettings.data?.settings.monitorServer !== false;
  const prefs = useModulePrefs();
  const hasAuthentik =
    (registry.data?.modules.some((m) => m.id === "authentik") ?? false) &&
    !(prefs.data?.disabled ?? []).includes("authentik");
  const anyTab = showTalk || showServer || hasAuthentik;
  return (
    <NextcloudGate>
      {anyTab ? (
        <Tabs className="tabs">
          <TabList className="tabs__list" aria-label={t("modules.monitor.nav")}>
            {showTalk && (
              <Tab id="talk" className="tabs__tab">
                {t("modules.monitor.tabs.talk")}
              </Tab>
            )}
            {showServer && (
              <Tab id="server" className="tabs__tab">
                {t("modules.monitor.tabs.server")}
              </Tab>
            )}
            {hasAuthentik && (
              <Tab id="authentik" className="tabs__tab">
                {t("modules.monitor.tabs.authentik")}
              </Tab>
            )}
          </TabList>
          {showTalk && (
            <TabPanel id="talk">
              <TalkPanel />
            </TabPanel>
          )}
          {showServer && (
            <TabPanel id="server">
              <ServerPanel />
            </TabPanel>
          )}
          {hasAuthentik && (
            <TabPanel id="authentik">
              <AuthentikPanel />
            </TabPanel>
          )}
        </Tabs>
      ) : (
        <div className="stack">
          <p className="muted">{t("modules.nextcloud.emptyHint")}</p>
          <div>
            <Button variant="outline" asChild>
              <Link to="/nextcloud">{t("modules.nextcloud.configure")}</Link>
            </Button>
          </div>
        </div>
      )}
    </NextcloudGate>
  );
}

/** Authentik instance health (D45) — or a link to the connector page when unconnected. */
function AuthentikPanel() {
  const { t } = useTranslation();
  const status = useConnectorStatus("authentik");
  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (status.data?.connected !== true) {
    return (
      <div className="stack">
        <p className="muted">{t("modules.authentik.monitorNotConnected")}</p>
        <div>
          <Button variant="outline" asChild>
            <Link to="/authentik">{t("modules.authentik.monitorConfigure")}</Link>
          </Button>
        </div>
      </div>
    );
  }
  return <AuthentikStatusView />;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmt(value: string | number | null | undefined): string {
  return value == null || value === "" ? "—" : String(value);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Relative ("2 hours ago") for the last week, else an absolute date; null for missing/never. */
function formatLastSeen(ms: number | null, lang: string): string | null {
  if (ms == null || ms <= 0) return null;
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS)
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(0, "minute");
  if (abs < HOUR_MS) {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
      Math.round(diff / MINUTE_MS),
      "minute",
    );
  }
  if (abs < DAY_MS) {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
      Math.round(diff / HOUR_MS),
      "hour",
    );
  }
  if (abs < 7 * DAY_MS) {
    return new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(
      Math.round(diff / DAY_MS),
      "day",
    );
  }
  return new Intl.DateTimeFormat(lang, { dateStyle: "medium" }).format(ms);
}

function Meter({ used, total, label }: { used: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="stack" style={{ gap: "var(--space-1)" }}>
      <meter className="meter" min={0} max={100} value={pct} aria-label={label} />
      <span className="muted">{label}</span>
    </div>
  );
}

function ServerPanel() {
  const { t } = useTranslation();
  const health = useServerHealth(true);

  if (health.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (health.isError) {
    const status = health.error instanceof ApiError ? health.error.status : "?";
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.monitor.server.error", { status })}</span>
        <Button variant="outline" onClick={() => void health.refetch()}>
          {t("modules.monitor.server.retry")}
        </Button>
      </div>
    );
  }
  if (!health.data.health) {
    return <BasicsCard basics={health.data.basics} />;
  }
  const h = health.data.health;

  const rows: [string, string][] = [
    [t("modules.monitor.server.version"), fmt(h.version)],
    [t("modules.monitor.server.webserver"), fmt(h.webserver)],
    [t("modules.monitor.server.php"), fmt(h.phpVersion)],
    [
      t("modules.monitor.server.database"),
      h.database
        ? `${fmt(h.database.type)} ${fmt(h.database.version)} (${formatBytes(h.database.sizeBytes)})`
        : "—",
    ],
    [t("modules.monitor.server.cpuLoad"), h.cpuLoad?.map((v) => v.toFixed(2)).join(" / ") ?? "—"],
    [t("modules.monitor.server.freeSpace"), formatBytes(h.freeSpaceBytes)],
    [
      t("modules.monitor.server.users"),
      h.users.total == null
        ? "—"
        : `${t("modules.monitor.server.usersTotal", { count: h.users.total })} · ${t(
            "modules.monitor.server.active",
            { m: h.users.last5min ?? 0, h: h.users.last1h ?? 0, d: h.users.last24h ?? 0 },
          )}`,
    ],
    [
      t("modules.monitor.server.apps"),
      h.apps.installed == null
        ? "—"
        : t("modules.monitor.server.appsDetail", {
            installed: h.apps.installed,
            updates: h.apps.updatesAvailable ?? 0,
            count: h.apps.updatesAvailable ?? 0,
          }),
    ],
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
      {h.memory && (
        <Meter
          used={h.memory.totalBytes - h.memory.freeBytes}
          total={h.memory.totalBytes}
          label={`${t("modules.monitor.server.memory")}: ${t("modules.monitor.server.freeOf", {
            free: formatBytes(h.memory.freeBytes),
            total: formatBytes(h.memory.totalBytes),
          })}`}
        />
      )}
      {h.swap && h.swap.totalBytes > 0 && (
        <Meter
          used={h.swap.totalBytes - h.swap.freeBytes}
          total={h.swap.totalBytes}
          label={`${t("modules.monitor.server.swap")}: ${t("modules.monitor.server.freeOf", {
            free: formatBytes(h.swap.freeBytes),
            total: formatBytes(h.swap.totalBytes),
          })}`}
        />
      )}
    </div>
  );
}

/** Non-admin fallback: what any authenticated user can see about the instance. */
function BasicsCard({ basics }: { basics: ServerBasics | null }) {
  const { t } = useTranslation();
  if (!basics) return <p className="muted">{t("modules.monitor.server.noAdmin")}</p>;

  const detected = [
    basics.apps.talk !== null ? `Talk${basics.apps.talk ? ` ${basics.apps.talk}` : ""}` : null,
    basics.apps.userStatus ? t("modules.monitor.server.appUserStatus") : null,
    basics.apps.collectives ? "Collectives" : null,
    basics.apps.tables ? "Tables" : null,
  ]
    .filter(Boolean)
    .join(", ");

  const rows: [string, string][] = [
    [t("modules.monitor.server.product"), fmt(basics.product)],
    [t("modules.monitor.server.version"), fmt(basics.version)],
    [t("modules.monitor.server.detectedApps"), detected || "—"],
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
      {basics.quota &&
        (basics.quota.totalBytes != null ? (
          <Meter
            used={basics.quota.usedBytes}
            total={basics.quota.totalBytes}
            label={`${t("modules.monitor.server.storage")}: ${t(
              "modules.monitor.server.storageOf",
              {
                used: formatBytes(basics.quota.usedBytes),
                total: formatBytes(basics.quota.totalBytes),
              },
            )}`}
          />
        ) : (
          <p className="muted">
            {t("modules.monitor.server.storage")}:{" "}
            {t("modules.monitor.server.storageUnlimited", {
              used: formatBytes(basics.quota.usedBytes),
            })}
          </p>
        ))}
      <p className="muted">{t("modules.monitor.server.noAdmin")}</p>
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  online: "status-dot--online",
  away: "status-dot--away",
  dnd: "status-dot--dnd",
  invisible: "status-dot--offline",
  offline: "status-dot--offline",
};

const ALL_GROUPS = "__all__";

function TalkPanel() {
  const { t, i18n } = useTranslation();
  const talk = useTalkStatus(true);
  const searchId = useId();
  const groupId = useId();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string>("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (talk.data?.users ?? []).filter(
      (u) =>
        (!q ||
          u.userId.toLowerCase().includes(q) ||
          (u.displayName ?? "").toLowerCase().includes(q)) &&
        (!group || u.groups.includes(group)),
    );
  }, [talk.data, search, group]);

  if (talk.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (talk.isError) {
    const status = talk.error instanceof ApiError ? talk.error.status : "?";
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.monitor.talk.error", { status })}</span>
        <Button variant="outline" onClick={() => void talk.refetch()}>
          {t("modules.monitor.talk.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <div className="flex flex-col gap-1">
          <Label htmlFor={searchId}>{t("modules.monitor.talk.search")}</Label>
          <Input
            id={searchId}
            className="w-56"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("modules.monitor.talk.search")}
            aria-label={t("modules.monitor.talk.search")}
          />
        </div>
        {talk.data.groupsScope !== "none" && talk.data.groups.length > 0 && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={groupId}>{t("modules.monitor.talk.group")}</Label>
            <Select
              value={group === "" ? ALL_GROUPS : group}
              onValueChange={(v) => setGroup(v === ALL_GROUPS ? "" : v)}
            >
              <SelectTrigger id={groupId} aria-label={t("modules.monitor.talk.group")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_GROUPS}>{t("modules.monitor.talk.allGroups")}</SelectItem>
                {talk.data.groups.map((g) => (
                  <SelectItem key={g} value={g}>
                    {g}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {talk.data.groupsScope === "none" && (
        <p className="muted">{t("modules.monitor.talk.noGroups")}</p>
      )}
      {talk.data.groupsScope === "partial" && (
        <p className="muted">{t("modules.monitor.talk.partialGroups")}</p>
      )}
      <p className="muted">{t("modules.monitor.talk.count", { count: filtered.length })}</p>
      {filtered.length === 0 ? (
        <p className="muted">{t("modules.monitor.talk.empty")}</p>
      ) : (
        <ul className="status-list">
          {filtered.map((u) => (
            <li key={u.userId} className="status-item">
              <span
                className={`status-dot ${STATUS_DOT[u.status] ?? "status-dot--offline"}`}
                aria-hidden
              />
              <span>{u.displayName ?? u.userId}</span>
              <span className="muted">
                {t(`modules.monitor.talk.status.${u.status}`, {
                  defaultValue: u.status,
                })}
              </span>
              {(u.icon || u.message) && (
                <span className="muted">
                  {u.icon ?? ""} {u.message ?? ""}
                </span>
              )}
              <time
                className="status-item__lastseen muted"
                dateTime={u.lastSeenAt ? new Date(u.lastSeenAt).toISOString() : undefined}
                title={
                  u.lastSeenAt
                    ? `${t("modules.monitor.talk.lastSeen")}: ${new Date(u.lastSeenAt).toLocaleString()}`
                    : t("modules.monitor.talk.lastSeen")
                }
              >
                {formatLastSeen(u.lastSeenAt, i18n.language) ?? "—"}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
