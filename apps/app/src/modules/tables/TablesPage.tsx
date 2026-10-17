import { Minus, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@/api/client";
import {
  useNextcloudConnection,
  useTableAddRow,
  useTableDeleteRow,
  useTableNode,
  useTablePatchRow,
  useTablesApplication,
} from "@/api/hooks";
import type { TableColumn, TableNode, TableRow, TableView } from "@/api/types";
import { formatCell } from "@/components/DataTable";
import { NextcloudGate } from "@/components/NextcloudGate";
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

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

export function TablesPage() {
  return (
    <NextcloudGate>
      <TablesContent />
    </NextcloudGate>
  );
}

function TablesContent() {
  const { t } = useTranslation();
  const connected = useNextcloudConnection().data?.status === "connected";
  const app = useTablesApplication(connected);
  const [node, setNode] = useState<TableNode | null>(null);

  // Auto-open the first node once the application loads.
  useEffect(() => {
    if (node === null && app.data?.nodes.length) setNode(app.data.nodes[0] ?? null);
  }, [app.data, node]);

  if (app.isPending) return <p className="muted">{t("modules.tables.loading")}</p>;
  if (app.isError) {
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.tables.error", { status: statusOf(app.error) })}</span>
        <Button variant="outline" onClick={() => void app.refetch()}>
          {t("modules.tables.retry")}
        </Button>
      </div>
    );
  }
  const data = app.data;
  if (!data || data.nodes.length === 0) {
    return <p className="muted">{t("modules.tables.emptyApp")}</p>;
  }

  return (
    <section className="stack">
      <div className="row">
        <h2>{data.name}</h2>
        {data.nodes.map((n) => (
          <Button
            key={`${n.type}:${n.id}`}
            variant={node?.type === n.type && node.id === n.id ? "outline" : "ghost"}
            onClick={() => setNode(n)}
          >
            {n.title}
          </Button>
        ))}
      </div>
      {node && <NodeGrid key={`${node.type}:${node.id}`} node={node} />}
    </section>
  );
}

function NodeGrid({ node }: { node: TableNode }) {
  const { t } = useTranslation();
  const view = useTableNode(node);
  const addRow = useTableAddRow();
  const deleteRow = useTableDeleteRow();

  if (view.isPending) return <p className="muted">{t("modules.tables.loading")}</p>;
  if (view.isError) {
    return (
      <div className="alert alert--danger row">
        <span>{t("modules.tables.error", { status: statusOf(view.error) })}</span>
        <Button variant="outline" onClick={() => void view.refetch()}>
          {t("modules.tables.retry")}
        </Button>
      </div>
    );
  }
  const data = view.data;
  if (!data) return null;

  return (
    <>
      <div className="row">
        <h3>
          {data.emoji ? `${data.emoji} ` : ""}
          {data.title}{" "}
          <span className="muted" style={{ fontSize: "var(--font-size-sm)" }}>
            {t("modules.tables.rowCount", { count: data.rows.length })}
          </span>
        </h3>
        <Button variant="outline" onClick={() => addRow.mutate(node)} disabled={addRow.isPending}>
          <Plus /> {t("modules.tables.addRow")}
        </Button>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {data.columns.map((c) => (
                <th key={c.id} scope="col">
                  {c.title}
                </th>
              ))}
              <th scope="col">
                <span className="sr-only">{t("modules.tables.deleteRow")}</span>
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
            {t("modules.tables.empty")}
          </p>
        )}
      </div>
      {(addRow.isError || deleteRow.isError) && (
        <div className="alert alert--danger">
          {t("modules.tables.error", { status: statusOf(addRow.error ?? deleteRow.error) })}
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
  const patchRow = useTablePatchRow(node);
  const commit = (columnId: number, value: unknown) =>
    patchRow.mutate({ rowId: row.id, data: { [columnId]: value } });

  return (
    <tr>
      {view.columns.map((c) => (
        <td key={c.id}>
          <CellEditor
            column={c}
            value={row.cells[String(c.id)]}
            onCommit={(v) => commit(c.id, v)}
          />
        </td>
      ))}
      <td>
        <Button
          variant="ghost"
          size="clear"
          onClick={onDelete}
          aria-label={t("modules.tables.deleteRow")}
        >
          <Trash2 />
        </Button>
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
  // Checkbox column (the "done" pattern) — a real Tables value, toggled in place.
  if (column.type === "selection" && column.subtype === "check") {
    return (
      <Checkbox
        checked={value === true || value === 1 || value === "true"}
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
  const { t } = useTranslation();
  const num = typeof value === "number" ? value : Number(value);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && Number(draft) !== num && draft.trim() !== "") onCommit(Number(draft));
    setDraft(null);
  };
  return (
    <span className="csv-cell">
      <Button
        variant="ghost"
        size="clear"
        onClick={() => onCommit(num - 1)}
        aria-label={t("modules.tables.decrease")}
      >
        <Minus />
      </Button>
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
      <Button
        variant="ghost"
        size="clear"
        onClick={() => onCommit(num + 1)}
        aria-label={t("modules.tables.increase")}
      >
        <Plus />
      </Button>
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
        <SelectValue placeholder={t("modules.tables.selectPlaceholder")} />
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
