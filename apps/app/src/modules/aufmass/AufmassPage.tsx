import { HardHat, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError } from "~/api/client";
import {
  useAufmassAddRow,
  useAufmassApplication,
  useAufmassDeleteRow,
  useAufmassNode,
  useAufmassPatchRow,
  useNextcloudConnection,
} from "~/api/hooks";
import type { TableColumn, TableNode, TableRow, TableView } from "~/api/types";
import { formatCell } from "~/components/DataTable";
import { NextcloudGate } from "~/components/NextcloudGate";

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

const isChecked = (v: unknown) => v === true || v === 1 || v === "true";
/** `YYYY-MM-DD HH:mm` — 24h, local time. */
const formatDateTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function AufmassPage() {
  return (
    <TooltipProvider delayDuration={0}>
      <NextcloudGate>
        <AufmassContent />
      </NextcloudGate>
    </TooltipProvider>
  );
}

function AufmassContent() {
  const { t } = useTranslation();
  const connected = useNextcloudConnection().data?.status === "connected";
  const app = useAufmassApplication(connected);
  const addRow = useAufmassAddRow();
  const [node, setNode] = useState<TableNode | null>(null);

  // Auto-open the first node once the application loads.
  useEffect(() => {
    if (node === null && app.data?.nodes.length) setNode(app.data.nodes[0] ?? null);
  }, [app.data, node]);

  if (app.isPending) return <p className="muted">{t("modules.aufmass.loading")}</p>;
  if (app.isError) {
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.aufmass.error", { status: statusOf(app.error) })}</span>
        <Button variant="outlined" onClick={() => void app.refetch()}>
          {t("modules.aufmass.retry")}
        </Button>
      </div>
    );
  }
  const data = app.data;
  if (!data || data.nodes.length === 0) {
    return <p className="muted">{t("modules.aufmass.emptyApp")}</p>;
  }

  return (
    <section className="stack">
      <div className="row">
        <h2>{data.name}</h2>
        {data.nodes.map((n) => (
          <Button
            key={`${n.type}:${n.id}`}
            variant={node?.type === n.type && node.id === n.id ? "outlined" : "text"}
            onClick={() => setNode(n)}
          >
            {n.title}
          </Button>
        ))}
        {node && (
          <Button
            variant="outlined"
            className="aufmass-add-btn"
            onClick={() => addRow.mutate(node)}
            disabled={addRow.isPending}
          >
            <Plus /> {t("modules.aufmass.addRow")}
          </Button>
        )}
      </div>
      {node && <NodeGrid key={`${node.type}:${node.id}`} node={node} addRow={addRow} />}
    </section>
  );
}

function NodeGrid({
  node,
  addRow,
}: {
  node: TableNode;
  addRow: ReturnType<typeof useAufmassAddRow>;
}) {
  const { t } = useTranslation();
  const view = useAufmassNode(node);
  const deleteRow = useAufmassDeleteRow();

  if (view.isPending) return <p className="muted">{t("modules.aufmass.loading")}</p>;
  if (view.isError) {
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.aufmass.error", { status: statusOf(view.error) })}</span>
        <Button variant="outlined" onClick={() => void view.refetch()}>
          {t("modules.aufmass.retry")}
        </Button>
      </div>
    );
  }
  const data = view.data;
  if (!data) return null;

  return (
    <>
      <div className="table-wrap aufmass-table-wrap">
        <table className="data-table aufmass-table">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.id} scope="col" style={c.width ? { width: `${c.width}px` } : undefined}>
                  {c.computed
                    ? t(`modules.aufmass.${c.title}`, { defaultValue: c.title })
                    : c.title}
                </th>
              ))}
              <th scope="col">{t("modules.aufmass.lastEdit")}</th>
              <th scope="col">
                <span className="sr-only">{t("modules.aufmass.deleteRow")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <RowEditor
                key={r.id}
                node={node}
                view={data}
                row={r}
                onDelete={() => deleteRow.mutate({ node, rowId: r.id })}
              />
            ))}
          </tbody>
        </table>
        {data.rows.length === 0 && (
          <p className="muted" style={{ padding: "var(--space-3)" }}>
            {t("modules.aufmass.empty")}
          </p>
        )}
      </div>
      <div className="row">
        <h3>
          {data.title}{" "}
          <span className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            {t("modules.aufmass.rowCount", { count: data.rows.length })}
          </span>
        </h3>
        <Button
          variant="outlined"
          className="aufmass-add-btn"
          onClick={() => addRow.mutate(node)}
          disabled={addRow.isPending}
        >
          <Plus /> {t("modules.aufmass.addRow")}
        </Button>
      </div>
      {(addRow.isError || deleteRow.isError) && (
        <div className="alert alert--danger">
          {t("modules.aufmass.error", { status: statusOf(addRow.error ?? deleteRow.error) })}
        </div>
      )}
    </>
  );
}

function RowEditor({
  node,
  view,
  row,
  onDelete,
}: {
  node: TableNode;
  view: TableView;
  row: TableRow;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const patchRow = useAufmassPatchRow(node);
  const commit = (columnId: number, value: unknown) =>
    patchRow.mutate({ rowId: row.id, data: { [columnId]: value } });
  // `entfällt` rows stay visible but struck through (FR-009).
  const cancelledCol = view.columns.find(
    (c) => c.type === "selection" && c.subtype === "check" && /entfällt/i.test(c.title),
  );
  const cancelled = cancelledCol !== undefined && isChecked(row.cells[String(cancelledCol.id)]);
  const editedBy =
    row.lastEditByDisplayName ?? row.lastEditBy ?? row.createdByDisplayName ?? row.createdBy;
  const editedAt = row.lastEditAt ?? row.createdAt;

  return (
    <tr className={cancelled ? "aufmass-row--cancelled" : undefined}>
      {view.columns.map((c) => (
        <td key={c.id} style={c.width ? { width: `${c.width}px` } : undefined}>
          <CellEditor
            column={c}
            value={row.cells[String(c.id)]}
            onCommit={(v) => commit(c.id, v)}
          />
        </td>
      ))}
      <td className="aufmass-row__meta">
        {editedBy ? (
          <Tooltip>
            <TooltipTrigger className="aufmass-row__meta-trigger" aria-label={editedBy}>
              <HardHat className="size-4" aria-hidden />
            </TooltipTrigger>
            <TooltipContent>
              {editedBy}
              {editedAt ? (
                <>
                  <br />
                  {formatDateTime(editedAt)}
                </>
              ) : null}
            </TooltipContent>
          </Tooltip>
        ) : (
          "—"
        )}
      </td>
      <td>
        {!row.original && (
          <Button
            variant="text"
            size="clear"
            className="aufmass-row__delete"
            onClick={onDelete}
            aria-label={t("modules.aufmass.deleteRow")}
          >
            <Trash2 />
          </Button>
        )}
      </td>
    </tr>
  );
}

function CellEditor({
  column,
  value,
  onCommit,
}: {
  column: TableColumn;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  // Computed (restmenge) and view-readonly columns render as plain text.
  if (column.computed || column.readonly) {
    return <span>{cellText(column, value, t)}</span>;
  }
  // Checkbox column (the "done" pattern) — a real Tables value, toggled in place.
  if (column.type === "selection" && column.subtype === "check") {
    return (
      <Checkbox
        checked={isChecked(value)}
        onCheckedChange={(v) => onCommit(v === true)}
        aria-label={column.title}
      />
    );
  }
  if (column.type === "number") {
    return <NumberCell value={value} label={column.title} onCommit={onCommit} />;
  }
  if (column.type === "selection" && column.options?.length) {
    return <SelectCell column={column} value={value} onCommit={onCommit} />;
  }
  if (column.type === "text" || column.type === "link") {
    return <TextCell value={formatCell(value, t)} label={column.title} onCommit={onCommit} />;
  }
  // datetime, usergroup, unknown — read-only in v1.
  return <span>{cellText(column, value, t)}</span>;
}

function NumberCell({
  value,
  label,
  onCommit,
}: {
  value: unknown;
  label: string;
  onCommit: (v: number) => void;
}) {
  const num = typeof value === "number" ? value : Number(value);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && Number(draft) !== num && draft.trim() !== "") onCommit(Number(draft));
    setDraft(null);
  };
  return (
    <span className="csv-cell">
      <Input
        type="number"
        className="csv-cell__input h-8 w-24"
        value={draft ?? (Number.isFinite(num) ? String(num) : "")}
        aria-label={label}
        onFocus={() => setDraft(Number.isFinite(num) ? String(num) : "")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </span>
  );
}

function SelectCell({
  column,
  value,
  onCommit,
}: {
  column: TableColumn;
  value: unknown;
  onCommit: (v: number) => void;
}) {
  const { t } = useTranslation();
  const options = column.options ?? [];
  const current = typeof value === "number" ? String(value) : undefined;
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        const id = Number(v);
        if (id !== value) onCommit(id);
      }}
    >
      <SelectTrigger className="h-8 w-36" aria-label={column.title}>
        <SelectValue placeholder={t("modules.aufmass.selectPlaceholder")} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={String(o.id)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TextCell({
  value,
  label,
  onCommit,
}: {
  value: string;
  label: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <Input
      className="csv-cell__input h-8 w-36"
      value={draft ?? value}
      aria-label={label}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Display text for read-only cells — resolves selection option ids to labels. */
function cellText(column: TableColumn, value: unknown, t: (key: string) => string): string {
  if (column.type === "selection" && column.options?.length) {
    const opts = column.options;
    const resolve = (v: unknown) => opts.find((o) => o.id === v)?.label ?? String(v);
    if (Array.isArray(value)) return value.map(resolve).join(", ");
    if (value !== null && value !== undefined && value !== "") return resolve(value);
  }
  return formatCell(value, t);
}
