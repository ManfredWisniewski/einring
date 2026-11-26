import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type EintimeEntryInput,
  useEintimeCreateEntry,
  useEintimeDeleteEntry,
  useEintimeProjects,
} from "~/api/hooks";
import type { EintimeSegment } from "~/api/types";
import { dayIso } from "./dates";
import { formatDuration, parseDurationMinutes } from "./duration";

interface SheetRow {
  key: string;
  label: string;
  mapping: EintimeEntryInput;
}

const rowKeyOf = (s: {
  provider: string | null;
  projectExternalId: string | null;
  taskExternalId: string | null;
  projectName: string | null;
  taskName: string | null;
}) =>
  s.projectExternalId || s.taskExternalId
    ? `ext:${s.provider}:${s.projectExternalId}:${s.taskExternalId}`
    : `name:${s.projectName}:${s.taskName}`;

function Cell({ minutes, onCommit }: { minutes: number; onCommit: (minutes: number) => void }) {
  const [value, setValue] = useState<string | null>(null);
  const shown = value ?? (minutes > 0 ? formatDuration(minutes) : "");
  return (
    <td>
      <input
        className="eintime-cell"
        value={shown}
        aria-label={formatDuration(minutes)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setValue(null);
          if (value === null) return;
          const parsed = parseDurationMinutes(value);
          if (parsed === null) return;
          if (parsed !== Math.round(minutes)) onCommit(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </td>
  );
}

/**
 * Timesheet matrix (spec eintime FR-008): one row per project+task, one column
 * per day; cells aggregate that day's minutes and a write replaces them.
 */
export function Timesheet({ days, segments }: { days: string[]; segments: EintimeSegment[] }) {
  const { t } = useTranslation();
  const projects = useEintimeProjects();
  const create = useEintimeCreateEntry();
  const del = useEintimeDeleteEntry();
  const [extraRows, setExtraRows] = useState<SheetRow[]>([]);

  const dayMinutes = (s: EintimeSegment) =>
    Math.max(0, (Date.parse(s.segEnd) - Date.parse(s.segStart)) / 60_000);

  const entryRows = new Map<string, SheetRow>();
  for (const s of segments) {
    const key = rowKeyOf(s);
    if (!entryRows.has(key)) {
      entryRows.set(key, {
        key,
        label:
          [s.projectName, s.taskName].filter(Boolean).join(" · ") ||
          s.description ||
          t("modules.eintime.noProject"),
        mapping: {
          provider: s.provider,
          projectExternalId: s.projectExternalId,
          taskExternalId: s.taskExternalId,
          clientName: s.clientName,
          projectName: s.projectName,
          taskName: s.taskName,
        },
      });
    }
  }
  const rows = [...entryRows.values(), ...extraRows.filter((r) => !entryRows.has(r.key))];

  const segsIn = (row: SheetRow, day: string) =>
    segments.filter((s) => s.day === day && rowKeyOf(s) === row.key);
  const cellMinutes = (row: SheetRow, day: string) =>
    segsIn(row, day).reduce((sum, s) => sum + dayMinutes(s), 0);

  const commit = (row: SheetRow, day: string, minutes: number) => {
    const ids = [...new Set(segsIn(row, day).map((s) => s.entryId))];
    for (const id of ids) del.mutate(id);
    if (minutes > 0) {
      create.mutate({ start: dayIso(day, 0), durationMinutes: minutes, ...row.mapping });
    }
  };

  const addRow = (value: string) => {
    const [projectExternalId, taskExternalId] = value.split("|");
    const project = projects.data?.projects.find((p) => p.externalId === projectExternalId);
    const task = projects.data?.tasks.find(
      (x) => x.projectExternalId === projectExternalId && x.externalId === taskExternalId,
    );
    const client = projects.data?.clients.find((c) => c.externalId === project?.clientExternalId);
    const mapping: EintimeEntryInput = {
      provider: project?.provider ?? null,
      projectExternalId: project?.externalId ?? null,
      taskExternalId: task?.externalId ?? null,
      clientName: client?.name ?? null,
      projectName: project?.name ?? null,
      taskName: task?.name ?? null,
    };
    const key = rowKeyOf({
      provider: mapping.provider ?? null,
      projectExternalId: mapping.projectExternalId ?? null,
      taskExternalId: mapping.taskExternalId ?? null,
      projectName: mapping.projectName ?? null,
      taskName: mapping.taskName ?? null,
    });
    setExtraRows((prev) =>
      prev.some((r) => r.key === key)
        ? prev
        : [
            ...prev,
            {
              key,
              label: [project?.name, task?.name].filter(Boolean).join(" · "),
              mapping,
            },
          ],
    );
  };

  const dayTotals = days.map((day) =>
    segments.filter((s) => s.day === day).reduce((sum, s) => sum + dayMinutes(s), 0),
  );
  const rowTotal = (row: SheetRow) => days.reduce((sum, day) => sum + cellMinutes(row, day), 0);

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data-table eintime-sheet">
          <thead>
            <tr>
              <th>{t("modules.eintime.rowHeader")}</th>
              {days.map((day) => (
                <th key={day}>
                  {new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
                    weekday: "short",
                    day: "numeric",
                  })}
                </th>
              ))}
              <th>{t("modules.eintime.total")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>{row.label}</td>
                {days.map((day) => (
                  <Cell
                    key={day}
                    minutes={cellMinutes(row, day)}
                    onCommit={(m) => commit(row, day, m)}
                  />
                ))}
                <td>{formatDuration(rowTotal(row))}</td>
              </tr>
            ))}
            <tr>
              <td className="muted">{t("modules.eintime.total")}</td>
              {dayTotals.map((m, i) => (
                <td key={days[i]}>{formatDuration(m)}</td>
              ))}
              <td>{formatDuration(dayTotals.reduce((a, b) => a + b, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div>
        <Select onValueChange={addRow}>
          <SelectTrigger className="min-w-60" aria-label={t("modules.eintime.addRow")}>
            <SelectValue placeholder={t("modules.eintime.addRow")} />
          </SelectTrigger>
          <SelectContent>
            {(projects.data?.tasks ?? []).map((x) => (
              <SelectItem
                key={`${x.projectExternalId}|${x.externalId}`}
                value={`${x.projectExternalId}|${x.externalId}`}
              >
                {projects.data?.projects.find((p) => p.externalId === x.projectExternalId)?.name} ·{" "}
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
