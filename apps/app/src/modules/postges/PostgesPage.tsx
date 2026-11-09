import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "~/api/client";
import {
  type PostgesRowsQuery,
  postgesPk,
  usePostgesConnect,
  usePostgesDelete,
  usePostgesDisconnect,
  usePostgesInsert,
  usePostgesRows,
  usePostgesStatus,
  usePostgesTables,
  usePostgesUpdate,
} from "~/api/hooks";
import type { PostgesColumn } from "~/api/types";
import { formatCell } from "~/components/DataTable";

const PAGE_SIZE = 50;
const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

interface TableRef {
  schema: string;
  name: string;
}

export function PostgesPage() {
  const { t } = useTranslation();
  const status = usePostgesStatus();
  const [table, setTable] = useState<TableRef | null>(null);

  if (status.isPending) return <p className="muted">{t("common.loading")}</p>;
  if (status.isError) {
    return (
      <div className="alert alert--danger">
        {status.error instanceof ApiError ? `API ${status.error.status}` : String(status.error)}
      </div>
    );
  }
  if (!status.data?.connected) return <ConnectForm />;
  if (table)
    return (
      <TableView table={table} readOnly={status.data.readOnly} onBack={() => setTable(null)} />
    );
  return <TableList readOnly={status.data.readOnly} onOpen={setTable} />;
}

function ConnectForm() {
  const { t } = useTranslation();
  const connect = usePostgesConnect();
  const [url, setUrl] = useState("");

  return (
    <section className="stack">
      <p className="muted">{t("modules.postges.intro")}</p>
      <div className="row" style={{ alignItems: "end" }}>
        <div className="flex flex-col gap-1 grow">
          <Label htmlFor="postges-url">{t("modules.postges.url")}</Label>
          <Input
            id="postges-url"
            type="password"
            autoComplete="off"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgres://user:pass@host:5432/db"
          />
        </div>
        <Button
          onClick={() => connect.mutate(url.trim())}
          disabled={connect.isPending || !url.trim()}
        >
          {connect.isPending ? t("modules.postges.connecting") : t("modules.postges.connect")}
        </Button>
      </div>
      {connect.isError && (
        <div className="alert alert--danger">
          {connect.error instanceof ApiError && connect.error.status === 401
            ? t("modules.postges.invalidCredential")
            : t("modules.postges.connectError", { status: statusOf(connect.error) })}
        </div>
      )}
    </section>
  );
}

function TableList({ readOnly, onOpen }: { readOnly: boolean; onOpen: (t: TableRef) => void }) {
  const { t } = useTranslation();
  const tables = usePostgesTables();
  const disconnect = usePostgesDisconnect();
  const [filter, setFilter] = useState("");

  const shown = (tables.data ?? []).filter((t) =>
    `${t.schema}.${t.name}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <section className="stack">
      <div className="row">
        <h2>{t("modules.postges.tables")}</h2>
        <span className="muted grow" />
        {readOnly && <span className="muted">{t("modules.postges.readOnly")}</span>}
        <Button
          variant="outlined"
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
        >
          {t("modules.postges.disconnect")}
        </Button>
      </div>
      <div className="row">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("modules.postges.filterTables")}
          aria-label={t("modules.postges.filterTables")}
        />
      </div>
      {tables.isPending && <p className="muted">{t("common.loading")}</p>}
      {tables.isError && (
        <div className="alert alert--danger row">
          <span>{t("modules.postges.error", { status: statusOf(tables.error) })}</span>
          <Button variant="outlined" onClick={() => void tables.refetch()}>
            {t("modules.postges.retry")}
          </Button>
        </div>
      )}
      {tables.data && shown.length === 0 && (
        <p className="muted">{t("modules.postges.noTables")}</p>
      )}
      {shown.length > 0 && (
        <div className="stack">
          {shown.map((t) => (
            <button
              key={`${t.schema}.${t.name}`}
              type="button"
              className="row"
              style={{
                justifyContent: "space-between",
                width: "100%",
                padding: "var(--space-3)",
                border: "1px solid var(--surface-border)",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-raised)",
                cursor: "pointer",
                textAlign: "left",
              }}
              onClick={() => onOpen({ schema: t.schema, name: t.name })}
            >
              <span>
                <strong>{t.name}</strong>{" "}
                <span className="muted">
                  {t.schema} · {t.kind}
                </span>
              </span>
              <span className="muted">{t.rowEstimate}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function TableView({
  table,
  readOnly,
  onBack,
}: {
  table: TableRef;
  readOnly: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<PostgesRowsQuery["sort"]>(undefined);
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [editing, setEditing] = useState<{ row: Record<string, unknown> | null } | null>(null);

  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQ(q);
      setOffset(0);
    }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const rows = usePostgesRows(table, {
    q: debouncedQ || undefined,
    sort,
    dir,
    offset,
    limit: PAGE_SIZE,
  });
  const insert = usePostgesInsert(table);
  const update = usePostgesUpdate(table);
  const del = usePostgesDelete(table);

  const columns = (rows.data?.columns ?? []).filter((c) => !c.internal);
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = rows.data ? Math.max(1, Math.ceil(rows.data.total / PAGE_SIZE)) : 1;

  const toggleSort = (name: string) => {
    if (sort === name) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(name);
      setDir("asc");
    }
    setOffset(0);
  };

  return (
    <section className="stack">
      <div className="row">
        <Button variant="text" size="clear" onClick={onBack}>
          <ArrowLeft /> {t("modules.postges.back")}
        </Button>
        <h2>
          {table.schema}.{table.name}
        </h2>
        {!readOnly && (
          <Button variant="outlined" onClick={() => setEditing({ row: null })}>
            <Plus /> {t("modules.postges.addRow")}
          </Button>
        )}
      </div>
      <div className="row">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("modules.postges.search")}
          aria-label={t("modules.postges.search")}
        />
      </div>
      {rows.isPending && <p className="muted">{t("common.loading")}</p>}
      {rows.isError && (
        <div className="alert alert--danger row">
          <span>{t("modules.postges.error", { status: statusOf(rows.error) })}</span>
          <Button variant="outlined" onClick={() => void rows.refetch()}>
            {t("modules.postges.retry")}
          </Button>
        </div>
      )}
      {rows.data && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.name} scope="col">
                      <Button
                        variant="text"
                        className="underline-offset-4 hover:underline"
                        size="clear"
                        onClick={() => toggleSort(c.name)}
                      >
                        {c.name}
                        {sort === c.name ? (dir === "asc" ? " ↑" : " ↓") : ""}
                      </Button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.data.rows.map((row, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable client id — pk may be composite/absent
                  <tr key={i} onClick={() => setEditing({ row })} style={{ cursor: "pointer" }}>
                    {columns.map((c) => (
                      <td key={c.name}>{formatCell(row[c.name], t)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.data.rows.length === 0 && (
              <p className="muted" style={{ padding: "var(--space-3)" }}>
                {t("modules.postges.emptyRows")}
              </p>
            )}
          </div>
          <div className="row">
            <Button
              variant="outlined"
              disabled={offset === 0 || rows.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              {t("modules.postges.prev")}
            </Button>
            <span className="muted">
              {t("modules.postges.page", { page, pages: totalPages, total: rows.data.total })}
            </span>
            <Button
              variant="outlined"
              disabled={offset + PAGE_SIZE >= rows.data.total || rows.isFetching}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              {t("modules.postges.next")}
            </Button>
          </div>
        </>
      )}
      {editing && (
        <RowPanel
          table={table}
          columns={columns}
          row={editing.row}
          readOnly={readOnly}
          saving={insert.isPending || update.isPending}
          onClose={() => setEditing(null)}
          onSave={(values, pk) => {
            if (editing.row === null) {
              insert.mutate(values, { onSuccess: () => setEditing(null) });
            } else if (pk) {
              update.mutate({ pk, values }, { onSuccess: () => setEditing(null) });
            }
          }}
          onDelete={
            editing.row !== null
              ? () => {
                  const pk = postgesPk(
                    editing.row as Record<string, unknown>,
                    rows.data?.columns ?? [],
                  );
                  if (pk) del.mutate(pk, { onSuccess: () => setEditing(null) });
                }
              : undefined
          }
          deleting={del.isPending}
        />
      )}
      {(insert.isError || update.isError || del.isError) && (
        <div className="alert alert--danger">
          {t("modules.postges.mutationError", {
            status: statusOf(insert.error ?? update.error ?? del.error),
          })}
        </div>
      )}
    </section>
  );
}

/** Draft editor for one row — text inputs, checkboxes for boolean columns. */
function RowPanel({
  table,
  columns,
  row,
  readOnly,
  saving,
  deleting,
  onClose,
  onSave,
  onDelete,
}: {
  table: TableRef;
  columns: PostgesColumn[];
  row: Record<string, unknown> | null;
  readOnly: boolean;
  saving: boolean;
  deleting: boolean;
  onClose: () => void;
  onSave: (values: Record<string, unknown>, pk: unknown[] | null) => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const isNew = row === null;
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      columns.map((c) => [
        c.name,
        row?.[c.name] === null || row?.[c.name] === undefined
          ? ""
          : typeof row[c.name] === "object"
            ? JSON.stringify(row[c.name])
            : String(row[c.name]),
      ]),
    ),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pkCols = columns.filter((c) => c.pk > 0);
  const pk = row ? postgesPk(row, columns) : null;

  const collect = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const c of columns) {
      // pk columns are identity, not editable; on insert an empty pk falls back to the column default.
      if (!isNew && pkCols.some((p) => p.name === c.name)) continue;
      if (isNew && c.pk > 0 && (draft[c.name] ?? "") === "") continue;
      const raw = draft[c.name] ?? "";
      if (c.type === "boolean") {
        values[c.name] = raw === "true";
      } else {
        values[c.name] = raw === "" ? null : raw;
      }
    }
    return values;
  };

  return (
    <div
      className="stack"
      style={{
        border: "1px solid var(--surface-border)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-3)",
      }}
    >
      <div className="row">
        <h3>{isNew ? t("modules.postges.newRow") : `${table.schema}.${table.name}`}</h3>
        <span className="muted grow" />
        <Button variant="text" size="clear" onClick={onClose}>
          {t("modules.postges.close")}
        </Button>
      </div>
      {columns.map((c) => {
        const isPk = pkCols.some((p) => p.name === c.name);
        const disabled = readOnly || (!isNew && isPk);
        return (
          <div key={c.name} className="flex flex-col gap-1">
            <Label htmlFor={`f-${c.name}`}>
              {c.name}
              {isPk ? ` (${t("modules.postges.pk")})` : ""}
            </Label>
            {c.type === "boolean" && !disabled ? (
              <Checkbox
                id={`f-${c.name}`}
                checked={draft[c.name] === "true"}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, [c.name]: v === true ? "true" : "false" })
                }
              />
            ) : (
              <Input
                id={`f-${c.name}`}
                value={draft[c.name] ?? ""}
                disabled={disabled}
                onChange={(e) => setDraft({ ...draft, [c.name]: e.target.value })}
              />
            )}
          </div>
        );
      })}
      {!readOnly && (
        <div className="row">
          <Button onClick={() => onSave(collect(), pk)} disabled={saving}>
            {saving ? t("modules.postges.saving") : t("modules.postges.save")}
          </Button>
          {onDelete &&
            (confirmDelete ? (
              <>
                <Button
                  variant="filled"
                  className="bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90"
                  onClick={onDelete}
                  disabled={deleting}
                >
                  {t("modules.postges.confirmDelete")}
                </Button>
                <Button variant="text" onClick={() => setConfirmDelete(false)}>
                  {t("modules.postges.back")}
                </Button>
              </>
            ) : (
              <Button variant="text" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> {t("modules.postges.deleteRow")}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
