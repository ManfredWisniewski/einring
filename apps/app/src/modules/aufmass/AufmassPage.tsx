import { CircleUserRound, Eye, FilterX, ListFilter, Loader2, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu";
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
import { formatCell, formatNumber } from "~/components/DataTable";
import { NextcloudGate } from "~/components/NextcloudGate";

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : "?");

const isChecked = (v: unknown) => v === true || v === 1 || v === "true";
/** Synthetic filter id for the meta ("edited") column — real column ids are positive. */
const META_FILTER_ID = -2;
/** Group-view suffixes (FR-016): `&lt;table&gt;_gf|_plan|_monteur|_abrechnung` (`-` separator seen for `_gf`). */
const GROUPS = ["gf", "plan", "monteur", "abrechnung"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_SUFFIX = /[-_](gf|plan|monteur|abrechnung)$/i;
const groupOf = (title: string): Group | undefined =>
  GROUPS.find((g) => g === GROUP_SUFFIX.exec(title)?.[1]?.toLowerCase());
const baseOf = (title: string) => title.replace(GROUP_SUFFIX, "");

/** Item kind derived from the base table title's last segment. */
const ITEM_KINDS: Array<[RegExp, string]> = [
  [/^bauelement/i, "bauelement"],
  [/^kan/i, "kanal"],
  [/^rohr/i, "rohr"],
];

function itemKindOf(title: string | undefined): string | null {
  const segment = title ? (baseOf(title).split(/[-_]/).pop() ?? "") : "";
  return ITEM_KINDS.find(([re]) => re.test(segment))?.[1] ?? null;
}

/** Display title — computed columns and real "Restmenge" columns use the
 * translated short label. */
function displayTitle(t: ReturnType<typeof useTranslation>["t"], c: TableColumn): string {
  const key = c.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  return c.computed || key === "restmenge"
    ? t(`modules.aufmass.${key}`, { defaultValue: c.title })
    : c.title;
}

function addRowLabel(t: ReturnType<typeof useTranslation>["t"], title: string | undefined): string {
  const kind = itemKindOf(title);
  return kind
    ? t("modules.aufmass.addItem", { item: t(`modules.aufmass.item.${kind}`) })
    : t("modules.aufmass.addRow");
}
const editorOf = (r: TableRow) =>
  r.lastEditByDisplayName ?? r.lastEditBy ?? r.createdByDisplayName ?? r.createdBy ?? "";
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
  const [addOpen, setAddOpen] = useState(false);

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

  const bases = [...new Set(data.nodes.map((n) => baseOf(n.title)))];
  const currentBase = node ? baseOf(node.title) : null;
  const group = node ? groupOf(node.title) : undefined;
  const viewFor = (base: string, g: Group) =>
    data.nodes.find((n) => n.type === "view" && groupOf(n.title) === g && baseOf(n.title) === base);
  const primaryOf = (base: string) =>
    data.nodes.find((n) => n.title === base) ?? data.nodes.find((n) => baseOf(n.title) === base);
  const pick = (base: string) => {
    const preferred = group
      ? (viewFor(base, group) ?? primaryOf(base))
      : (viewFor(base, "gf") ?? primaryOf(base));
    if (preferred) setNode(preferred);
  };
  const hasGroupViews = currentBase !== null && GROUPS.some((g) => viewFor(currentBase, g));

  return (
    <section className="stack">
      <div className="row">
        <h2>{data.name}</h2>
        {bases.map((b) => (
          <Button
            key={b}
            variant={b === currentBase ? "outlined" : "text"}
            className="aufmass-node-btn"
            onClick={() => pick(b)}
          >
            <span className="aufmass-node-btn__label">{b}</span>
          </Button>
        ))}
        <Button variant="text">{t("modules.aufmass.einbauteileliste")}</Button>
        {node && currentBase && hasGroupViews && (
          <Select
            value={group ?? ""}
            onValueChange={(g) => {
              const sib = viewFor(currentBase, g as Group);
              if (sib) setNode(sib);
            }}
          >
            <SelectTrigger
              className="aufmass-view-select h-8"
              aria-label={t("modules.aufmass.viewAs")}
            >
              <SelectValue placeholder={t("modules.aufmass.viewAs")} />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((g) => (
                <SelectItem key={g} value={g} disabled={!viewFor(currentBase, g)}>
                  {t(`modules.aufmass.group_${g}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {node && (
          <Button
            variant="outlined"
            className="aufmass-add-btn"
            onClick={() => setAddOpen(true)}
            disabled={addRow.isPending}
          >
            <Plus /> {addRowLabel(t, node.title)}
          </Button>
        )}
      </div>
      {node && (
        <NodeGrid
          key={`${node.type}:${node.id}`}
          node={node}
          addRow={addRow}
          addOpen={addOpen}
          onAddOpenChange={setAddOpen}
          appTitle={app.data?.name}
        />
      )}
    </section>
  );
}

/** Title text that only shows its hover tooltip when actually ellipsized. */
function TruncatedText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [truncated, setTruncated] = useState(false);
  const check = useCallback(() => {
    const el = ref.current;
    if (el) setTruncated(el.scrollWidth > el.clientWidth);
  }, []);
  useEffect(() => {
    check();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [check]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} className="aufmass-truncate" onPointerEnter={check}>
          {text}
        </span>
      </TooltipTrigger>
      {truncated && <TooltipContent>{text}</TooltipContent>}
    </Tooltip>
  );
}

function NodeGrid({
  node,
  addRow,
  addOpen,
  onAddOpenChange,
  appTitle,
}: {
  node: TableNode;
  addRow: ReturnType<typeof useAufmassAddRow>;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  appTitle?: string;
}) {
  const { t } = useTranslation();
  const view = useAufmassNode(node);
  const deleteRow = useAufmassDeleteRow();
  const patchRow = useAufmassPatchRow(node);
  const [filters, setFilters] = useState<Record<number, string | Set<string>>>({});
  const [amountRow, setAmountRow] = useState<TableRow | null>(null);
  // Mutation errors render inside their dialog — a page-level banner hides behind the modal.
  const [amountError, setAmountError] = useState<string>();
  const [addError, setAddError] = useState<string>();
  const tableRef = useRef<HTMLTableElement>(null);

  // Per-user, per-node column visibility — persisted in localStorage so it
  // survives reloads; re-read if the connection's loginName arrives late.
  const connection = useNextcloudConnection().data;
  const loginName = connection?.status === "connected" ? connection.loginName : "anonymous";
  const storageKey = `aufmass:hidden-columns:${loginName}:${node.type}:${node.id}`;
  const [hiddenCols, setHiddenCols] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as number[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      setHiddenCols(new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]") as number[]));
    } catch {
      setHiddenCols(new Set());
    }
  }, [storageKey]);
  const toggleCol = (id: number, visible: boolean) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });

  // Defer the heavy grid render one frame: this commit paints the spinner
  // first, then the (possibly large) table mounts in the next render. Latches
  // on — later refetches update in place without unmounting the grid.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || !view.data) return;
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, [view.data, ready]);

  // Cap column widths only when the natural (uncapped) table width overflows
  // the wrap — measure without the class, re-apply if needed. The measurement
  // forces a synchronous layout, so it only runs when inputs change plus on
  // wrap resize; the class toggle itself is synchronous (no flicker).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps re-trigger the width measurement on data/filter/visibility changes
  useLayoutEffect(() => {
    const table = tableRef.current;
    const wrap = table?.closest(".aufmass-table-wrap");
    if (!table || !wrap) return;
    const update = () => {
      table.classList.remove("aufmass-table--capped");
      table.classList.toggle("aufmass-table--capped", table.scrollWidth > wrap.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [view.data, filters, hiddenCols]);

  const setFilter = (colId: number, f: string | Set<string> | undefined) =>
    setFilters((prev) => {
      const next = { ...prev };
      if (f === undefined || f === "" || (f instanceof Set && f.size === 0)) delete next[colId];
      else next[colId] = f;
      return next;
    });

  if (view.isPending)
    return (
      <p className="muted">
        {appTitle
          ? t("modules.aufmass.loadingList", { list: baseOf(node.title), app: appTitle })
          : t("modules.aufmass.loading")}
      </p>
    );
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

  // First frame after data arrives: cheap spinner commit so the user sees
  // feedback while the full grid mounts on the next render.
  if (!ready) {
    return (
      <p className="muted row">
        {appTitle
          ? t("modules.aufmass.readingList", { list: baseOf(node.title), app: appTitle })
          : t("modules.aufmass.loading")}
        <Loader2 className="size-4 animate-spin" aria-hidden />
      </p>
    );
  }

  const matches = (c: TableColumn, r: TableRow) => {
    const f = filters[c.id];
    if (f === undefined) return true;
    const cell = r.cells[String(c.id)];
    if (f instanceof Set) return f.has(String(cell ?? ""));
    if (c.type === "number" || c.computed === true) {
      const n = Number(f);
      return Number.isFinite(n) && Number(cell) === n;
    }
    return String(cell ?? "")
      .toLowerCase()
      .includes(f.toLowerCase());
  };
  // Monteur checklist UX (Bauelemente): each planned unit gets its own row —
  // Anz−Verbaut unchecked copies plus Verbaut checked copies; toggling PATCHes
  // ±1. Kanal/Rohr instead get a "+" button that adds a decimal amount.
  const monteur =
    groupOf(node.title) === "monteur" &&
    data.plannedColumnId !== undefined &&
    data.verbautColumnId !== undefined;
  const monteurItem = monteur ? itemKindOf(node.title) : null;

  const metaFilter = filters[META_FILTER_ID];
  const itemKind = itemKindOf(node.title);
  const rows = data.rows.filter((r) => {
    if (
      (metaFilter instanceof Set && metaFilter.size > 0 && !metaFilter.has(editorOf(r))) ||
      !data.columns.every((c) => matches(c, r))
    )
      return false;
    // Kanal/Rohr: positions without a Wert (empty or 0) hide — in all views.
    if ((itemKind === "kanal" || itemKind === "rohr") && data.plannedColumnId !== undefined) {
      const wert = Number(r.cells[String(data.plannedColumnId)]);
      if (!Number.isFinite(wert) || wert === 0) return false;
    }
    return true;
  });

  // Auto-hide columns whose cells are all empty ("", "-", "*" — checked over
  // every row, filters don't change it). Pos.Nr. and LV-Nummer are exempt.
  const columns = data.columns.filter((c) => {
    if (hiddenCols.has(c.id)) return false;
    if (monteur && monteurItem === "bauelement" && c.id === data.plannedColumnId) return false;
    const titleKey = c.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (titleKey === "posnr" || titleKey === "lvnummer") return true;
    return data.rows.some((r) => {
      const v = r.cells[String(c.id)];
      return v !== undefined && v !== null && !["", "-", "*"].includes(String(v).trim());
    });
  });
  const exploded =
    monteur && monteurItem === "bauelement"
      ? rows.flatMap((r) => {
          const anz = Math.max(0, Math.floor(Number(r.cells[String(data.plannedColumnId)])) || 0);
          const verbaut = Math.max(
            0,
            Math.floor(Number(r.cells[String(data.verbautColumnId)])) || 0,
          );
          const open = Math.max(0, Math.max(1, anz) - verbaut);
          const total = Math.max(1, open + verbaut);
          return Array.from({ length: total }, (_, i) => ({ row: r, built: i < verbaut }));
        })
      : rows.map((r) => ({ row: r, built: null }));

  return (
    <>
      <div className="table-wrap aufmass-table-wrap">
        <table ref={tableRef} className="data-table aufmass-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.id} scope="col" style={c.width ? { width: `${c.width}px` } : undefined}>
                  <TruncatedText text={displayTitle(t, c)} />
                </th>
              ))}
              {!monteur && (
                <th scope="col">
                  <TruncatedText text={t("modules.aufmass.lastEdit")} />
                </th>
              )}
              <th scope="col">
                <span className="sr-only">{t("modules.aufmass.deleteRow")}</span>
                <ColumnVisibilityMenu
                  columns={data.columns}
                  hidden={hiddenCols}
                  onToggle={toggleCol}
                />
              </th>
            </tr>
            <tr className="aufmass-filter-row">
              {columns.map((c) => (
                <th key={c.id}>
                  <ColumnFilter
                    column={c}
                    rows={data.rows}
                    value={filters[c.id]}
                    onChange={(v) => setFilter(c.id, v)}
                  />
                </th>
              ))}
              {!monteur && (
                <th>
                  <MultiSelectFilter
                    options={[...new Set(data.rows.map(editorOf))]
                      .filter((v) => v !== "")
                      .sort((a, b) => a.localeCompare(b))}
                    selected={
                      filters[META_FILTER_ID] instanceof Set
                        ? (filters[META_FILTER_ID] as Set<string>)
                        : new Set<string>()
                    }
                    label={t("modules.aufmass.filterColumn", {
                      column: t("modules.aufmass.lastEdit"),
                    })}
                    onChange={(v) => setFilter(META_FILTER_ID, v)}
                  />
                </th>
              )}
              <th>
                <Tooltip>
                  <TooltipTrigger
                    className="aufmass-filter__trigger"
                    aria-label={t("modules.aufmass.clearFilters")}
                    disabled={Object.keys(filters).length === 0}
                    onClick={() => setFilters({})}
                  >
                    <FilterX className="size-4" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>{t("modules.aufmass.clearFilters")}</TooltipContent>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {exploded.map(({ row, built }, i) => (
              <RowEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: per-unit copies of one row have no unique id
                key={`${row.id}:${i}`}
                view={{ ...data, columns }}
                row={row}
                showMeta={!monteur}
                patchRow={patchRow}
                verbautToggle={
                  built !== null && data.verbautColumnId !== undefined
                    ? {
                        columnId: data.verbautColumnId,
                        checked: built,
                        value: Number(row.cells[String(data.verbautColumnId)]) || 0,
                      }
                    : undefined
                }
                verbautAdd={
                  monteur && monteurItem !== "bauelement" && data.verbautColumnId !== undefined
                    ? { columnId: data.verbautColumnId, onAdd: () => setAmountRow(row) }
                    : undefined
                }
                decimals={itemKindOf(node.title) === "kanal" ? 2 : undefined}
                restUnit={(() => {
                  const kind = itemKindOf(node.title);
                  return kind
                    ? t(`modules.aufmass.restUnit_${kind}`, { defaultValue: "" }) || undefined
                    : undefined;
                })()}
                onDelete={() => deleteRow.mutate({ node, rowId: row.id })}
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
          onClick={() => onAddOpenChange(true)}
          disabled={addRow.isPending}
        >
          <Plus /> {addRowLabel(t, node.title)}
        </Button>
      </div>
      <AddRowDialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddError(undefined);
          onAddOpenChange(o);
        }}
        columns={data.allColumns ?? data.columns}
        title={addRowLabel(t, node.title)}
        pending={addRow.isPending}
        error={addError}
        onSubmit={(data) =>
          addRow.mutate(
            { node, data },
            {
              onSuccess: () => onAddOpenChange(false),
              onError: (e) => setAddError(t("modules.aufmass.error", { status: statusOf(e) })),
            },
          )
        }
      />
      {data.verbautColumnId !== undefined && (
        <AddAmountDialog
          row={amountRow}
          columnId={data.verbautColumnId}
          decimals={itemKindOf(node.title) === "kanal" ? 2 : undefined}
          rest={(() => {
            if (!amountRow || data.plannedColumnId === undefined) return undefined;
            const planned = Number(amountRow.cells[String(data.plannedColumnId)]);
            const verbaut = Number(amountRow.cells[String(data.verbautColumnId)]) || 0;
            return Number.isFinite(planned) ? planned - verbaut : undefined;
          })()}
          columnTitle={data.columns.find((c) => c.id === data.verbautColumnId)?.title ?? "Verbaut"}
          item={t(`modules.aufmass.item.${monteurItem ?? "kanal"}`)}
          unit={(() => {
            // The row's own Einheit cell wins (Kanal carries units per row);
            // otherwise the per-item default unit applies.
            const einheitCol = data.columns.find(
              (c) => c.title.toLowerCase().replace(/[^a-z0-9]/g, "") === "einheit",
            );
            const cellUnit =
              einheitCol && amountRow ? String(amountRow.cells[String(einheitCol.id)] ?? "") : "";
            return (
              cellUnit ||
              t(`modules.aufmass.unit_${monteurItem ?? "default"}`, {
                defaultValue: t("modules.aufmass.unit_default"),
              })
            );
          })()}
          pending={patchRow.isPending}
          error={amountError}
          onClose={() => {
            setAmountError(undefined);
            setAmountRow(null);
          }}
          onSubmit={(amount) => {
            if (!amountRow) return;
            const current = Number(amountRow.cells[String(data.verbautColumnId)]) || 0;
            setAmountError(undefined);
            patchRow.mutate(
              { rowId: amountRow.id, data: { [data.verbautColumnId!]: current + amount } },
              {
                onSuccess: () => setAmountRow(null),
                onError: (e) =>
                  setAmountError(t("modules.aufmass.error", { status: statusOf(e) })),
              },
            );
          }}
        />
      )}
      {(addRow.isError || deleteRow.isError || patchRow.isError) && (
        <div className="alert alert--danger">
          {t("modules.aufmass.error", {
            status: statusOf(addRow.error ?? deleteRow.error ?? patchRow.error),
          })}
        </div>
      )}
    </>
  );
}

/** Column-visibility dropdown in the title row — checked = shown. */
function ColumnVisibilityMenu({
  columns,
  hidden,
  onToggle,
}: {
  columns: TableColumn[];
  hidden: Set<number>;
  onToggle: (id: number, visible: boolean) => void;
}) {
  const { t } = useTranslation();
  const PROTECTED = ["bezeichnung", "raum"];
  const hidable = columns.filter(
    (c) => !PROTECTED.includes(c.title.toLowerCase().replace(/[^a-z0-9]/g, "")),
  );
  const label = t("modules.aufmass.hideColumns");
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger asChild>
          <MenuTrigger className="aufmass-filter__trigger" aria-label={label}>
            <Eye className="size-4" aria-hidden />
          </MenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <MenuContent>
        {hidable.map((c) => (
          <MenuCheckboxItem
            key={c.id}
            checked={!hidden.has(c.id)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onToggle(c.id, on === true)}
          >
            {displayTitle(t, c)}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Per-column filter control — number input, text match, or multi-select dropdown. */
function ColumnFilter({
  column,
  rows,
  value,
  onChange,
}: {
  column: TableColumn;
  rows: TableRow[];
  value: string | Set<string> | undefined;
  onChange: (v: string | Set<string> | undefined) => void;
}) {
  const { t } = useTranslation();
  const label = t("modules.aufmass.filterColumn", { column: column.title });
  const textValue = typeof value === "string" ? value : "";
  // Anz (planned quantity) gets no filter.
  if (column.title.trim().toLowerCase() === "anz") return null;
  if (column.type === "number" || column.computed === true) {
    return (
      <Input
        type="number"
        className="csv-cell__input aufmass-cell-input h-7"
        size={4}
        value={textValue}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }
  if (column.type !== "text" && column.type !== "link") return null;
  // Bezeichnung/Pos.Nr./LV-Nummer always get the text-input filter.
  const titleKey = column.title.toLowerCase().replace(/[^a-z0-9]/g, "");
  const forceTextFilter = ["bezeichnung", "posnr", "lvnummer"].includes(titleKey);
  const distinct = [...new Set(rows.map((r) => String(r.cells[String(column.id)] ?? "")))].sort(
    (a, b) => a.localeCompare(b),
  );
  if (forceTextFilter || distinct.length > 10) {
    return (
      <Input
        type="text"
        className="csv-cell__input aufmass-cell-input h-7"
        size={8}
        value={textValue}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
      />
    );
  }
  const selected = value instanceof Set ? value : new Set<string>();
  return (
    <MultiSelectFilter options={distinct} selected={selected} label={label} onChange={onChange} />
  );
}

/** Multi-select checkbox dropdown — stays open while toggling values. */
function MultiSelectFilter({
  options,
  selected,
  label,
  onChange,
}: {
  options: string[];
  selected: Set<string>;
  label: string;
  onChange: (v: Set<string> | undefined) => void;
}) {
  const { t } = useTranslation();
  const toggle = (v: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(v);
    else next.delete(v);
    onChange(next.size === 0 ? undefined : next);
  };
  return (
    <Menu>
      <MenuTrigger className="aufmass-filter__trigger" aria-label={label}>
        <ListFilter className="size-4" aria-hidden />
        {selected.size > 0 && <span className="aufmass-filter__count">{selected.size}</span>}
      </MenuTrigger>
      <MenuContent>
        {options.map((v) => (
          <MenuCheckboxItem
            key={v}
            checked={selected.has(v)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => toggle(v, on === true)}
          >
            {v === "" ? t("modules.aufmass.filterEmpty") : v}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Entry form for new rows — one control per editable column, in a modal. */
function AddRowDialog({
  open,
  onOpenChange,
  columns,
  title,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: TableColumn[];
  title: string;
  pending: boolean;
  error?: string;
  onSubmit: (data: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<number, unknown>>({});
  // All real columns get a form field — readonly view columns too (the view
  // forbids row editing, so this dialog is the data-entry path). Only the
  // BFF-synthetic computed columns drop out (no backing column to write).
  const editable = columns.filter((c) => !c.computed);
  const set = (id: number, v: unknown) => setValues((prev) => ({ ...prev, [id]: v }));
  // Mandatory fields (Tables `mandatory` / view columnSettings) must be filled
  // before the row can be submitted.
  const missing = editable.some(
    (c) => c.mandatory === true && (values[c.id] === undefined || values[c.id] === ""),
  );
  const submit = () => {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== undefined) data[k] = v;
    onSubmit(data);
  };
  return (
    <ModalOverlay
      className="app-modal-overlay"
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) setValues({});
        onOpenChange(o);
      }}
      isDismissable
    >
      <Modal className="app-modal">
        <Dialog>
          <Heading slot="title">{title}</Heading>
          <div className="app-modal__scroll aufmass-add-form">
            {editable.map((c) => (
              <div key={c.id} className="aufmass-add-form__field">
                <span>
                  {c.title}
                  {c.mandatory === true && (
                    <span aria-hidden className="aufmass-add-form__required">
                      {" "}
                      *
                    </span>
                  )}
                </span>
                {c.type === "number" ? (
                  <Input
                    type="number"
                    value={values[c.id] === undefined ? "" : String(values[c.id])}
                    aria-label={c.title}
                    required={c.mandatory === true}
                    onChange={(e) =>
                      set(c.id, e.target.value === "" ? undefined : Number(e.target.value))
                    }
                  />
                ) : c.type === "selection" && c.subtype === "check" ? (
                  <Checkbox
                    checked={isChecked(values[c.id])}
                    onCheckedChange={(v) => set(c.id, v === true)}
                    aria-label={c.title}
                  />
                ) : c.type === "selection" && c.options?.length ? (
                  <Select
                    value={values[c.id] === undefined ? "" : String(values[c.id])}
                    onValueChange={(v) => set(c.id, Number(v))}
                  >
                    <SelectTrigger className="w-full" aria-label={c.title}>
                      <SelectValue placeholder={t("modules.aufmass.selectPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {c.options.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type="text"
                    value={typeof values[c.id] === "string" ? (values[c.id] as string) : ""}
                    aria-label={c.title}
                    required={c.mandatory === true}
                    onChange={(e) => set(c.id, e.target.value === "" ? undefined : e.target.value)}
                  />
                )}
              </div>
            ))}
          </div>
          {error && <div className="alert alert--danger">{error}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button variant="text" onClick={() => onOpenChange(false)} disabled={pending}>
              {t("modules.aufmass.cancel")}
            </Button>
            <Button variant="outlined" onClick={submit} disabled={pending || missing}>
              {title}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Decimal-amount input for Kanal/Rohr monteur rows — adds to Verbaut. */
function AddAmountDialog({
  row,
  columnId,
  columnTitle,
  rest,
  decimals,
  item,
  unit,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  row: TableRow | null;
  columnId: number;
  columnTitle: string;
  /** Localized item name (Kanal/Rohr) for the amount-field label. */
  item: string;
  /** Remaining planned quantity (Soll − Verbaut) shown as "Verfügbar". */
  rest?: number;
  /** Fixed fraction digits for displayed numbers (e.g. Kanal: always x,xx). */
  decimals?: number;
  unit: string;
  pending: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (amount: number) => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState("");
  // Fresh, empty input for every row the dialog opens on.
  const rowId = row?.id;
  useEffect(() => {
    if (rowId !== undefined) setAmount("");
  }, [rowId]);
  // Accept both decimal separators — de/fr/ru users type the comma.
  const value = Number(amount.replace(",", "."));
  const current = row ? Number(row.cells[String(columnId)]) || 0 : 0;
  const exceeded = rest !== undefined && Number.isFinite(value) && value > rest;
  return (
    <ModalOverlay
      className="app-modal-overlay"
      isOpen={row !== null}
      onOpenChange={(o) => {
        if (!o) {
          setAmount("");
          onClose();
        }
      }}
      isDismissable
    >
      <Modal className="app-modal">
        <Dialog>
          <Heading slot="title">{t("modules.aufmass.addAmountTitle")}</Heading>
          <div className="aufmass-add-form">
            <div className="aufmass-add-form__field">
              <span>{columnTitle}</span>
              <span className="aufmass-verbaut__current">
                {formatNumber(current, decimals)} {unit}
              </span>
            </div>
            {rest !== undefined && (
              <div className="aufmass-add-form__field">
                <span className={exceeded ? "aufmass-add-form__error" : undefined}>
                  {t("modules.aufmass.available")}
                </span>
                <span
                  className={`aufmass-verbaut__current${exceeded ? " aufmass-add-form__error" : ""}`}
                >
                  {formatNumber(rest, decimals)} {unit}
                  {exceeded ? ` ${t("modules.aufmass.exceeded")}` : ""}
                  {exceeded && Number.isFinite(value) && value > rest * 10 && (
                    <span className="aufmass-add-form__mindblown"> 🤯</span>
                  )}
                </span>
              </div>
            )}
            <div className="aufmass-add-form__field">
              <span>
                {t("modules.aufmass.addAmountLabel", { item, unit })}
                <span aria-hidden className="aufmass-add-form__required">
                  {" "}
                  *
                </span>
              </span>
              <Input
                type="text"
                inputMode="decimal"
                value={amount}
                aria-label={t("modules.aufmass.addAmountTitle")}
                required
                autoFocus
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          {error && <div className="alert alert--danger">{error}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <Button variant="text" tabIndex={-1} onClick={onClose} disabled={pending}>
              {t("modules.aufmass.cancel")}
            </Button>
            <Button
              variant="outlined"
              onClick={() => onSubmit(value)}
              disabled={pending || !Number.isFinite(value) || value <= 0 || exceeded}
            >
              {t("modules.aufmass.add")}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function RowEditor({
  view,
  row,
  showMeta,
  patchRow,
  verbautToggle,
  verbautAdd,
  decimals,
  restUnit,
  onDelete,
}: {
  view: TableView;
  row: TableRow;
  showMeta: boolean;
  patchRow: ReturnType<typeof useAufmassPatchRow>;
  /** Monteur mode: this copy is one installed unit — Verbaut renders as a ±1 checkbox. */
  verbautToggle?: { columnId: number; checked: boolean; value: number };
  /** Monteur mode (Kanal/Rohr): Verbaut shows its number plus a "+" that opens the amount dialog. */
  verbautAdd?: { columnId: number; onAdd: () => void };
  /** Fixed fraction digits for displayed numbers (e.g. Kanal: always x,xx). */
  decimals?: number;
  /** Unit suffix appended to the computed Rest column's values. */
  restUnit?: string;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const commit = (columnId: number, value: unknown) =>
    patchRow.mutate({ rowId: row.id, data: { [columnId]: value } });
  // `entfällt` rows stay visible but struck through (FR-009).
  const cancelledCol = view.columns.find(
    (c) => c.type === "selection" && c.subtype === "check" && /entfällt/i.test(c.title),
  );
  const cancelled = cancelledCol !== undefined && isChecked(row.cells[String(cancelledCol.id)]);
  const editedBy = editorOf(row) || undefined;
  const editedAt = row.lastEditAt ?? row.createdAt;

  return (
    <tr className={cancelled ? "aufmass-row--cancelled" : undefined}>
      {view.columns.map((c) => (
        <td
          key={c.id}
          className={c.computed ? "aufmass-cell--right" : undefined}
          style={c.width ? { width: `${c.width}px` } : undefined}
        >
          {verbautToggle && c.id === verbautToggle.columnId ? (
            patchRow.isPending && patchRow.variables?.rowId === row.id ? (
              <Loader2
                className="size-4 animate-spin text-current aufmass-cell__loader"
                aria-label={t("modules.aufmass.loading")}
              />
            ) : (
              <Checkbox
                checked={verbautToggle.checked}
                disabled={cancelled}
                aria-label={c.title}
                onCheckedChange={(v) =>
                  commit(c.id, Math.max(0, verbautToggle.value + (v === true ? 1 : -1)))
                }
              />
            )
          ) : verbautAdd && c.id === verbautAdd.columnId ? (
            <span className="aufmass-verbaut">
              <CellEditor
                column={c}
                value={row.cells[String(c.id)]}
                locked={row.original === true}
                decimals={decimals}
                restUnit={restUnit}
                onCommit={(v) => commit(c.id, v)}
              />
              {patchRow.isPending && patchRow.variables?.rowId === row.id ? (
                <Loader2
                  className="size-4 animate-spin text-current aufmass-cell__loader"
                  aria-label={t("modules.aufmass.loading")}
                />
              ) : (
                <button
                  type="button"
                  className="aufmass-verbaut__add"
                  disabled={cancelled}
                  aria-label={t("modules.aufmass.addAmountTitle")}
                  onClick={verbautAdd.onAdd}
                >
                  <Plus className="size-3.5" aria-hidden />
                </button>
              )}
            </span>
          ) : (
            <CellEditor
              column={c}
              value={row.cells[String(c.id)]}
              locked={row.original === true}
              decimals={decimals}
              restUnit={restUnit}
              onCommit={(v) => commit(c.id, v)}
            />
          )}
        </td>
      ))}
      {showMeta && (
        <td className="aufmass-row__meta">
          {editedBy ? (
            <Tooltip>
              <TooltipTrigger className="aufmass-row__meta-trigger" aria-label={editedBy}>
                <CircleUserRound className="size-4" aria-hidden />
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
      )}
      <td>
        <DeleteButton onConfirm={onDelete} disabled={row.original === true} />
      </td>
    </tr>
  );
}

/** Delete affordance with a confirmation modal before the row is actually dropped. */
function DeleteButton({ onConfirm, disabled }: { onConfirm: () => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="text"
        size="clear"
        className="aufmass-row__delete"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={t("modules.aufmass.deleteRow")}
      >
        <Trash2 />
      </Button>
      <ModalOverlay
        className="app-modal-overlay"
        isOpen={open}
        onOpenChange={setOpen}
        isDismissable
      >
        <Modal className="app-modal">
          <Dialog>
            <Heading slot="title">{t("modules.aufmass.deleteConfirmTitle")}</Heading>
            <p className="muted">{t("modules.aufmass.deleteConfirm")}</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <Button variant="text" onClick={() => setOpen(false)}>
                {t("modules.aufmass.cancel")}
              </Button>
              <Button
                variant="outlined"
                onClick={() => {
                  setOpen(false);
                  onConfirm();
                }}
              >
                {t("modules.aufmass.deleteRow")}
              </Button>
            </div>
          </Dialog>
        </Modal>
      </ModalOverlay>
    </>
  );
}

function CellEditor({
  column,
  value,
  locked,
  decimals,
  restUnit,
  onCommit,
}: {
  column: TableColumn;
  value: unknown;
  /** Original (imported) rows are read-only — display values as text. */
  locked?: boolean;
  /** Fixed fraction digits for displayed numbers (e.g. Kanal: always x,xx). */
  decimals?: number;
  /** Unit suffix appended to the computed Rest column's values. */
  restUnit?: string;
  onCommit: (v: unknown) => void;
}) {
  const { t } = useTranslation();
  // Original rows, computed (restmenge) and view-readonly columns render as text.
  if (locked || column.computed || column.readonly) {
    return <TruncatedText text={cellText(column, value, t, decimals, restUnit)} />;
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
  return <TruncatedText text={cellText(column, value, t, decimals, restUnit)} />;
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
        className="csv-cell__input aufmass-cell-input h-8"
        size={4}
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
      className="csv-cell__input aufmass-cell-input h-8"
      size={8}
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
function cellText(
  column: TableColumn,
  value: unknown,
  t: (key: string) => string,
  decimals?: number,
  restUnit?: string,
): string {
  if (column.type === "selection" && column.options?.length) {
    const opts = column.options;
    const resolve = (v: unknown) => opts.find((o) => o.id === v)?.label ?? String(v);
    if (Array.isArray(value)) return value.map(resolve).join(", ");
    if (value !== null && value !== undefined && value !== "") return resolve(value);
  }
  if (column.computed && restUnit !== undefined && typeof value === "number")
    return `${formatNumber(value, decimals)} ${restUnit}`;
  if (decimals !== undefined && typeof value === "number") return formatNumber(value, decimals);
  return formatCell(value, t);
}
