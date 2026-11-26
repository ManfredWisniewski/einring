import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEintimeProjects, useEintimeReport, useEintimeTags } from "~/api/hooks";
import { dayKey } from "./dates";
import { formatDuration } from "./duration";

const ALL = "__all";
const opt = (v: string | null) => v ?? ALL;
const unopt = (v: string) => (v === ALL ? "" : v);

/**
 * Report view (spec eintime FR-011): filter by range, client, project, task,
 * tag and billable; group by project/task/client; totals + entry rows.
 */
export function Report() {
  const { t } = useTranslation();
  const projects = useEintimeProjects();
  const tags = useEintimeTags();

  const today = dayKey(new Date());
  const monthAgo = dayKey(new Date(Date.now() - 29 * 86_400_000));
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState("project");
  const [client, setClient] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [billable, setBillable] = useState("any");

  const params = new URLSearchParams({
    from: new Date(`${from}T00:00:00`).toISOString(),
    to: new Date(`${to}T23:59:59.999`).toISOString(),
    groupBy,
  });
  if (client) params.set("client", client);
  if (project) params.set("project", project);
  if (task) params.set("task", task);
  if (tag) params.set("tag", tag);
  if (billable !== "any") params.set("billable", billable === "yes" ? "true" : "false");
  const report = useEintimeReport(params.toString());

  const tasks = (projects.data?.tasks ?? []).filter(
    (x) => !project || x.projectExternalId === project,
  );

  return (
    <div className="stack">
      <div className="row">
        <Label className="row gap-1">
          {t("modules.eintime.reportFrom")}
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Label>
        <Label className="row gap-1">
          {t("modules.eintime.reportTo")}
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Label>
        <Select value={groupBy} onValueChange={setGroupBy}>
          <SelectTrigger className="min-w-36" aria-label={t("modules.eintime.groupBy")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">{t("modules.eintime.groupProject")}</SelectItem>
            <SelectItem value="task">{t("modules.eintime.groupTask")}</SelectItem>
            <SelectItem value="client">{t("modules.eintime.groupClient")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={opt(client)} onValueChange={(v) => setClient(unopt(v) || null)}>
          <SelectTrigger className="min-w-36" aria-label={t("modules.eintime.client")}>
            <SelectValue placeholder={t("modules.eintime.client")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("modules.eintime.all")} — {t("modules.eintime.client")}
            </SelectItem>
            {(projects.data?.clients ?? []).map((c) => (
              <SelectItem key={`${c.provider}:${c.externalId}`} value={c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={opt(project)} onValueChange={(v) => setProject(unopt(v) || null)}>
          <SelectTrigger className="min-w-36" aria-label={t("modules.eintime.project")}>
            <SelectValue placeholder={t("modules.eintime.project")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("modules.eintime.all")} — {t("modules.eintime.project")}
            </SelectItem>
            {(projects.data?.projects ?? []).map((p) => (
              <SelectItem key={`${p.provider}:${p.externalId}`} value={p.externalId}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={opt(task)} onValueChange={(v) => setTask(unopt(v) || null)}>
          <SelectTrigger className="min-w-36" aria-label={t("modules.eintime.task")}>
            <SelectValue placeholder={t("modules.eintime.task")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("modules.eintime.all")} — {t("modules.eintime.task")}
            </SelectItem>
            {tasks.map((x) => (
              <SelectItem key={x.externalId} value={x.externalId}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={opt(tag)} onValueChange={(v) => setTag(unopt(v) || null)}>
          <SelectTrigger className="min-w-32" aria-label={t("modules.eintime.tags")}>
            <SelectValue placeholder={t("modules.eintime.tags")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>
              {t("modules.eintime.all")} — {t("modules.eintime.tags")}
            </SelectItem>
            {(tags.data?.tags ?? []).map((x) => (
              <SelectItem key={x.id} value={x.name}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={billable} onValueChange={setBillable}>
          <SelectTrigger className="min-w-36" aria-label={t("modules.eintime.billable")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("modules.eintime.billableAny")}</SelectItem>
            <SelectItem value="yes">{t("modules.eintime.billableOnly")}</SelectItem>
            <SelectItem value="no">{t("modules.eintime.billableNo")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {report.data && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t(`modules.eintime.group${cap(groupBy)}`)}</th>
                  <th>{t("modules.eintime.entries")}</th>
                  <th>{t("modules.eintime.total")}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.groups.map((g) => (
                  <tr key={g.key || "(none)"}>
                    <td>{g.name ?? t("modules.eintime.noProject")}</td>
                    <td>{g.entryCount}</td>
                    <td>{formatDuration(g.minutes)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">{t("modules.eintime.total")}</td>
                  <td>{report.data.entries.length}</td>
                  <td>{formatDuration(report.data.totalMinutes)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t("modules.eintime.whatWorking")}</th>
                  <th>{t("modules.eintime.project")}</th>
                  <th>{t("modules.eintime.task")}</th>
                  <th>{t("modules.eintime.tags")}</th>
                  <th>{t("modules.eintime.billable")}</th>
                  <th>{t("modules.eintime.reportFrom")}</th>
                  <th>{t("modules.eintime.reportTo")}</th>
                  <th>{t("modules.eintime.total")}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{e.description}</td>
                    <td>{e.projectName}</td>
                    <td>{e.taskName}</td>
                    <td>{e.tags.join(", ")}</td>
                    <td>{e.billable ? "✓" : ""}</td>
                    <td>{new Date(e.start).toLocaleString()}</td>
                    <td>
                      {e.end ? new Date(e.end).toLocaleString() : t("modules.eintime.running")}
                    </td>
                    <td>{formatDuration(e.minutes)}</td>
                  </tr>
                ))}
                {report.data.entries.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      {t("modules.eintime.reportEmpty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
      {report.isPending && <p className="muted">{t("common.loading")}</p>}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
