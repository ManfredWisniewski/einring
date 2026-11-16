import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type {
  AuthenticatedNextcloud,
  TablesColumn,
  TablesContext,
  TablesContextNode,
  TablesRow,
} from "../nextcloud/client.js";
import { NextcloudError } from "../nextcloud/client.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Context (application) id from the Nextcloud Tables `/app/<id>` URL. Empty/missing = not configured. */
  APPLICATION_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  /** Title candidates (comma-separated) for the planned-quantity column —
   * restmenge is computed only when both quantities resolve. */
  PLANNED_COLUMN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("Anz,Wert"),
  ),
  /** Title candidates (comma-separated) for the installed-quantity column (`Verbaut`). */
  VERBAUT_COLUMN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("Verbaut"),
  ),
  /**
   * Title of the hidden marker column that flags imported rows. Checked rows are
   * `original` — only Tables admins may delete them; user-added rows stay deletable.
   */
  ORIGINAL_COLUMN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("original"),
  ),
});

type NodeType = "view" | "table";

/** Synthetic read-only column id — negative ids never collide with Tables column ids. */
const RESTMENGE_COLUMN_ID = -1;

/** Authenticated client for a user, or null when their Nextcloud is disconnected. */
const ncFor = (ctx: AppContext, sub: string): AuthenticatedNextcloud | null => {
  const cred = ctx.store.getCredential(sub);
  return cred
    ? ctx.nextcloud.withCredentials(cred.loginName, ctx.secrets.open(cred.appPasswordSealed))
    : null;
};

export interface AufmassApplication {
  name: string;
  nodes: { type: NodeType; id: number; title: string }[];
}

export interface AufmassColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  options?: { id: number; label: string }[];
  /** BFF-computed read-only column (e.g. restmenge) — never editable. */
  computed?: boolean;
  /** View `columnSettings.readonly` — display value as text, no editor. */
  readonly?: boolean;
  /** Tables/view `mandatory` flag — required input in the add-row form. */
  mandatory?: boolean;
  /** Column width in px from Tables `customSettings.width` — absent on older releases. */
  width?: number;
}

interface AufmassView {
  kind: NodeType;
  id: number;
  title: string;
  emoji?: string;
  /** Column ids for the planned/installed quantities — monteur per-unit UX needs them. */
  plannedColumnId?: number;
  verbautColumnId?: number;
  columns: AufmassColumn[];
  /** Full table columns for view nodes — the add-row form offers every field. */
  allColumns?: AufmassColumn[];
  rows: {
    id: number;
    cells: Record<string, unknown>;
    createdAt?: string;
    createdBy?: string;
    /** Display name resolved from `createdBy` (row meta carries user ids only). */
    createdByDisplayName?: string;
    lastEditAt?: string;
    lastEditBy?: string;
    lastEditByDisplayName?: string;
    /** True when the hidden `original` marker column is checked (imported row — no delete). */
    original?: boolean;
  }[];
}

/**
 * `data.nodes` is a ContextNodeRelation list — an array or an id-keyed map —
 * where `nodeType` is numeric (0 = table, 1 = view). Some releases instead put
 * `{nodeType: "view"|"table", nodeId, nodeTitle}` entries under `content` or
 * `pages[].content` — all three are flattened and deduped.
 */
function contextNodes(data: TablesContext): AufmassApplication["nodes"] {
  const out = new Map<string, { type: NodeType; id: number; title: string }>();
  const push = (n: TablesContextNode) => {
    const rawType = n.nodeType ?? n.node_type ?? (n as { type?: string }).type;
    const type =
      rawType === "view" || rawType === 1
        ? "view"
        : rawType === "table" || rawType === 0
          ? "table"
          : null;
    const id = Number(n.nodeId ?? n.node_id ?? (n as { id?: number | string }).id);
    if (!type || !Number.isInteger(id)) return;
    const key = `${type}:${id}`;
    if (!out.has(key)) {
      const rawTitle =
        n.nodeTitle ??
        n.node_title ??
        (n as { title?: string; label?: string }).title ??
        (n as { label?: string }).label;
      const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
      out.set(key, { type, id, title: title || `${type} ${id}` });
    }
  };
  // Array or id-keyed object map — iterate either.
  const each = (list: unknown, cb: (n: TablesContextNode) => void) => {
    const items = Array.isArray(list)
      ? list
      : list && typeof list === "object"
        ? Object.values(list)
        : [];
    for (const n of items) cb(n as TablesContextNode);
  };
  each(data.nodes, push);
  each(data.content, push);
  each(data.pages, (p) => each((p as { content?: unknown })?.content, push));
  return [...out.values()];
}

/** Raw cell values keyed by columnId — labels/types resolve client-side via the column list. */
function flattenRow(row: TablesRow) {
  return {
    id: row.id,
    cells: Object.fromEntries((row.data ?? []).map((d) => [d.columnId, d.value])),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    lastEditAt: row.lastEditAt,
    lastEditBy: row.lastEditBy,
  };
}

const toNum = (v: unknown) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** planned − installed; undefined when the planned quantity isn't numeric. */
const restOf = (planned: unknown, verbaut: unknown) => {
  const p = toNum(planned);
  if (p === undefined) return undefined;
  return p - (toNum(verbaut) ?? 0);
};

const colIdByTitle = (columns: { id: number; title: string }[], title: string) => {
  const want = title.trim().toLowerCase();
  return (
    columns.find((c) => c.title.trim().toLowerCase() === want)?.id ??
    // Item tables name quantity columns e.g. "Verbaut m²" / "Anzahl".
    columns.find((c) => c.title.trim().toLowerCase().startsWith(want))?.id
  );
};

/** First title in the comma-separated list that resolves to a column. */
const colIdByTitles = (columns: { id: number; title: string }[], titles: string) => {
  for (const t of titles.split(",")) {
    const id = colIdByTitle(columns, t);
    if (id !== undefined) return id;
  }
  return undefined;
};

const isChecked = (v: unknown) => v === true || v === 1 || v === "true";

/**
 * Hidden `original` marker column (checked = imported row, admin-only delete).
 * The column is stripped from the view and each row flagged — the grid never
 * renders it; `undefined` marker means "no gate" (all rows deletable).
 */
function withOriginal(
  view: AufmassView,
  markerId: number | undefined,
  markerByRowId?: Map<number, unknown>,
): AufmassView {
  if (markerId === undefined) return view;
  return {
    ...view,
    columns: view.columns.filter((c) => c.id !== markerId),
    rows: view.rows.map((r) => ({
      ...r,
      original: isChecked(markerByRowId?.get(r.id) ?? r.cells[String(markerId)]),
    })),
  };
}

/**
 * Maps Tables user ids (row meta carries uids, not names) to display names —
 * admin users-API first, sharee autocomplete as fallback for regular accounts.
 */
async function resolveUserNames(
  nc: AuthenticatedNextcloud,
  rows: { createdBy?: string; lastEditBy?: string }[],
  log?: FastifyBaseLogger,
): Promise<Map<string, string>> {
  const uids = [
    ...new Set(rows.flatMap((r) => [r.createdBy, r.lastEditBy]).filter((u): u is string => !!u)),
  ];
  const names = new Map<string, string>();
  await Promise.all(
    uids.map(async (uid) => {
      try {
        const name = (await nc.getUser(uid)).ocs.data.displayname;
        if (name) return void names.set(uid, name);
      } catch {
        // not admin — try the sharee autocomplete instead
      }
      try {
        const hit = (await nc.autocompleteUser(uid)).ocs.data.find((u) => u.id === uid);
        if (hit?.label) names.set(uid, hit.label);
      } catch (e) {
        log?.warn({ err: String(e), uid }, "aufmass user display-name lookup failed");
      }
    }),
  );
  return names;
}

/** Attaches resolved display names to a view's rows (no-op when lookup finds nothing). */
function withUserNames(view: AufmassView, names: Map<string, string>): AufmassView {
  if (names.size === 0) return view;
  return {
    ...view,
    rows: view.rows.map((r) => ({
      ...r,
      createdByDisplayName: r.createdBy ? names.get(r.createdBy) : undefined,
      lastEditByDisplayName: r.lastEditBy ? names.get(r.lastEditBy) : undefined,
    })),
  };
}

/** Restmenge (FR-008): appends a synthetic computed column planned − verbaut when both exist. */
function withRestmenge(view: AufmassView, config: z.infer<typeof configSchema>): AufmassView {
  const plannedId = colIdByTitles(view.columns, config.PLANNED_COLUMN);
  const verbautId = colIdByTitles(view.columns, config.VERBAUT_COLUMN);
  if (plannedId === undefined || verbautId === undefined) return view;
  return {
    ...view,
    plannedColumnId: plannedId,
    verbautColumnId: verbautId,
    columns: [
      ...view.columns,
      { id: RESTMENGE_COLUMN_ID, title: "restmenge", type: "computed", computed: true },
    ],
    rows: view.rows.map((r) => ({
      ...r,
      cells: {
        ...r.cells,
        [RESTMENGE_COLUMN_ID]: restOf(r.cells[String(plannedId)], r.cells[String(verbautId)]),
      },
    })),
  };
}

const mapColumn = (
  c: TablesColumn,
  readonlyIds?: Set<number>,
  mandatoryIds?: Set<number>,
): AufmassColumn => ({
  id: c.id,
  title: c.title,
  type: c.type,
  subtype: c.subtype,
  options: c.selectionOptions ?? undefined,
  width: c.customSettings?.width ?? undefined,
  readonly: readonlyIds?.has(c.id) || undefined,
  mandatory: mandatoryIds?.has(c.id) || c.mandatory === true || c.mandatory === 1 || undefined,
});

function toAufmassView(
  kind: NodeType,
  meta: { id: number; title: string; emoji?: string },
  columns: TablesColumn[],
  rows: TablesRow[],
  readonlyIds?: Set<number>,
  mandatoryIds?: Set<number>,
): AufmassView {
  return {
    kind,
    id: meta.id,
    title: meta.title,
    emoji: meta.emoji,
    columns: columns.map((c) => mapColumn(c, readonlyIds, mandatoryIds)),
    rows: rows.map(flattenRow),
  };
}

/** columnIds flagged `readonly` in the view's `columnSettings`. */
const readonlyColumnIds = (view: { columnSettings?: { columnId: number; readonly?: boolean }[] }) =>
  new Set((view.columnSettings ?? []).filter((s) => s.readonly === true).map((s) => s.columnId));

/** columnIds flagged `mandatory` in the view's `columnSettings`. */
const mandatoryColumnIds = (view: {
  columnSettings?: { columnId: number; mandatory?: boolean }[];
}) =>
  new Set((view.columnSettings ?? []).filter((s) => s.mandatory === true).map((s) => s.columnId));

export const aufmassModule: BffModule<z.infer<typeof configSchema>> = {
  id: "aufmass",
  requires: ["nextcloud"],
  configSchema,
  chatTools(ctx, config): ChatTool[] {
    return [
      {
        name: "aufmass_list_nodes",
        scope: "einchat",
        description:
          "List the tables and views in the configured Aufmaß application (Nextcloud Tables context). Returns node type, id and title — pass a node to aufmass_get_rows.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          if (config.APPLICATION_ID === undefined) {
            return { error: "aufmass application id not configured" };
          }
          const nc = ncFor(ctx, sub);
          if (!nc) return { error: "nextcloud is not connected" };
          const ctxRes = await nc.getContext(config.APPLICATION_ID);
          const data = ctxRes.ocs?.data ?? {};
          const settled = await Promise.allSettled(
            contextNodes(data).map(async (node) => {
              const meta =
                node.type === "view" ? await nc.getView(node.id) : await nc.getTable(node.id);
              return { ...node, title: meta.title || node.title };
            }),
          );
          const nodes = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
          return {
            name: (data.name ?? data.title ?? "").trim() || `Application ${config.APPLICATION_ID}`,
            nodes,
          };
        },
      },
      {
        name: "aufmass_get_rows",
        scope: "einchat",
        description:
          "Fetch the rows of an Aufmaß table or view (site measurement data). Cells are keyed by column title with selection values resolved to labels; 'restmenge' is planned (Anz) minus installed (Verbaut); 'original' flags imported rows. Returns at most 200 rows.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["view", "table"],
              description: "node type from aufmass_list_nodes",
            },
            id: { type: "integer", description: "node id from aufmass_list_nodes" },
          },
          required: ["type", "id"],
        },
        async call(args, sub) {
          const nc = ncFor(ctx, sub);
          if (!nc) return { error: "nextcloud is not connected" };
          const type = args.type === "view" ? "view" : args.type === "table" ? "table" : null;
          const id = Number(args.id);
          if (!type || !Number.isInteger(id) || id <= 0) {
            return { error: "expected {type: view|table, id}" };
          }
          const [meta, columns, rows] =
            type === "view"
              ? await Promise.all([nc.getView(id), nc.getViewColumns(id), nc.getViewRows(id)])
              : await Promise.all([nc.getTable(id), nc.getColumns(id), nc.getRows(id)]);
          // Marker col may be hidden in the view — fall back to table columns.
          const markerId =
            colIdByTitle(columns, config.ORIGINAL_COLUMN) ??
            (type === "view" && (meta as { tableId?: number }).tableId !== undefined
              ? colIdByTitle(
                  await nc.getColumns((meta as { tableId: number }).tableId).catch(() => []),
                  config.ORIGINAL_COLUMN,
                )
              : undefined);
          const plannedId = colIdByTitles(columns, config.PLANNED_COLUMN);
          const verbautId = colIdByTitles(columns, config.VERBAUT_COLUMN);
          const cellOf = (row: TablesRow, colId: number) =>
            row.data?.find((d) => d.columnId === colId)?.value;
          const resolveCell = (c: TablesColumn, v: unknown) => {
            if (c.type === "selection" && c.selectionOptions?.length) {
              const options = c.selectionOptions;
              const label = (o: unknown) => options.find((x) => x.id === o)?.label ?? String(o);
              if (Array.isArray(v)) return v.map(label);
              if (v !== null && v !== undefined && v !== "") return label(v);
            }
            return v;
          };
          const LIMIT = 200;
          const names = await resolveUserNames(nc, rows);
          const out = rows.slice(0, LIMIT).map((row) => {
            const titled: Record<string, unknown> = { _rowId: row.id };
            for (const c of columns) {
              if (c.id === markerId) continue;
              titled[c.title] = resolveCell(c, cellOf(row, c.id));
            }
            if (plannedId !== undefined && verbautId !== undefined) {
              titled.rest = restOf(cellOf(row, plannedId), cellOf(row, verbautId));
            }
            if (markerId !== undefined) titled._original = isChecked(cellOf(row, markerId));
            titled._lastEditBy = row.lastEditBy ? names.get(row.lastEditBy) : undefined;
            titled._lastEditAt = row.lastEditAt;
            return titled;
          });
          return {
            title: meta.title,
            rowCount: rows.length,
            truncated: rows.length > LIMIT,
            rows: out,
          };
        },
      },
    ];
  },

  register(api: FastifyInstance, ctx, config) {
    const nodeType = (s: string): NodeType | null =>
      s === "view" ? "view" : s === "table" ? "table" : null;

    api.get("/", async (req, reply) => {
      if (config.APPLICATION_ID === undefined) {
        return reply.code(424).send({ error: "aufmass application id not configured" });
      }
      const nc = ncFor(ctx, req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const ctxRes = await nc.getContext(config.APPLICATION_ID);
      const data = ctxRes.ocs?.data ?? {};
      // Context nodes carry no title — resolve each node's display title via its
      // v1 meta endpoint; nodes the user cannot read are dropped from the list.
      const settled = await Promise.allSettled(
        contextNodes(data).map(async (node) => {
          const meta =
            node.type === "view" ? await nc.getView(node.id) : await nc.getTable(node.id);
          return { ...node, title: meta.title || node.title };
        }),
      );
      for (const r of settled) {
        if (r.status === "rejected") {
          req.log.warn({ err: String(r.reason) }, "aufmass node meta fetch failed");
        }
      }
      const nodes = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      return {
        name: (data.name ?? data.title ?? "").trim() || `Application ${config.APPLICATION_ID}`,
        nodes,
      };
    });

    api.get("/nodes/:type/:id", async (req, reply) => {
      const nc = ncFor(ctx, req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const params = req.params as { type: string; id: string };
      const type = nodeType(params.type);
      const id = Number(params.id);
      if (!type || !Number.isInteger(id) || id <= 0) {
        return reply.code(400).send({ error: "node must be view|table and a positive id" });
      }
      try {
        if (type === "view") {
          const [view, columns, rows] = await Promise.all([
            nc.getView(id),
            nc.getViewColumns(id),
            nc.getViewRows(id),
          ]);
          // The table's columns serve two purposes: the marker may be hidden
          // in the view, and the add-row form needs every column the view hides.
          const tableColumns =
            view.tableId !== undefined
              ? await nc.getColumns(view.tableId).catch(() => [] as TablesColumn[])
              : [];
          const markerId =
            colIdByTitle(columns, config.ORIGINAL_COLUMN) ??
            colIdByTitle(tableColumns, config.ORIGINAL_COLUMN);
          // Hidden columns are absent from view row data — read the marker's
          // value from the table's rows when the view rows don't carry it.
          let markerByRowId: Map<number, unknown> | undefined;
          if (
            markerId !== undefined &&
            view.tableId !== undefined &&
            rows.some((r) => !(r.data ?? []).some((d) => d.columnId === markerId))
          ) {
            const tableRows = await nc.getRows(view.tableId).catch(() => [] as TablesRow[]);
            markerByRowId = new Map(
              tableRows.map((r) => [r.id, r.data?.find((d) => d.columnId === markerId)?.value]),
            );
          }
          const out = withRestmenge(
            withOriginal(
              toAufmassView(
                "view",
                view,
                columns,
                rows,
                readonlyColumnIds(view),
                mandatoryColumnIds(view),
              ),
              markerId,
              markerByRowId,
            ),
            config,
          );
          // Marker column stays out of the form just like the grid.
          out.allColumns = tableColumns.filter((c) => c.id !== markerId).map((c) => mapColumn(c));
          if (out.plannedColumnId === undefined || out.verbautColumnId === undefined) {
            req.log.info(
              { titles: columns.map((c) => c.title), viewId: id },
              "aufmass: planned/verbaut columns not resolved",
            );
          }
          return withUserNames(out, await resolveUserNames(nc, out.rows, req.log));
        }
        const [table, columns, rows] = await Promise.all([
          nc.getTable(id),
          nc.getColumns(id),
          nc.getRows(id),
        ]);
        const out = withRestmenge(
          withOriginal(
            toAufmassView("table", table, columns, rows),
            colIdByTitle(columns, config.ORIGINAL_COLUMN),
          ),
          config,
        );
        return withUserNames(out, await resolveUserNames(nc, out.rows, req.log));
      } catch (e) {
        if (e instanceof NextcloudError && e.status === 404) {
          return reply.code(404).send({ error: "node not found" });
        }
        throw e;
      }
    });

    const dataSchema = z.object({ data: z.record(z.string(), z.unknown()).optional() }).strict();

    api.patch("/rows/:rowId", async (req, reply) => {
      const nc = ncFor(ctx, req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const rowId = Number((req.params as { rowId: string }).rowId);
      const parsed = dataSchema.safeParse(req.body ?? {});
      if (!Number.isInteger(rowId) || rowId <= 0 || !parsed.success) {
        return reply.code(400).send({ error: "expected {data: {columnId: value}}" });
      }
      let row;
      try {
        row = await nc.updateRow(rowId, parsed.data.data ?? {});
      } catch (e) {
        // Pass upstream 4xx through so clients see the real cause (e.g. a row
        // shared read-only) instead of an opaque 502.
        if (e instanceof NextcloudError) {
          return reply.code(e.status < 500 ? e.status : 502).send({ error: e.message });
        }
        throw e;
      }
      const flat = flattenRow(row);
      let original: boolean | undefined;
      // Recompute restmenge so the client can swap the row in without a refetch;
      // a failing column fetch must not block the update response.
      try {
        const cols = await nc.getColumns(row.tableId);
        const plannedId = colIdByTitles(cols, config.PLANNED_COLUMN);
        const verbautId = colIdByTitles(cols, config.VERBAUT_COLUMN);
        if (plannedId !== undefined && verbautId !== undefined) {
          flat.cells[String(RESTMENGE_COLUMN_ID)] = restOf(
            flat.cells[String(plannedId)],
            flat.cells[String(verbautId)],
          );
        }
        const markerId = colIdByTitle(cols, config.ORIGINAL_COLUMN);
        if (markerId !== undefined) original = isChecked(flat.cells[String(markerId)]);
      } catch (e) {
        req.log.warn({ err: String(e) }, "aufmass restmenge recompute failed");
      }
      const names = await resolveUserNames(nc, [flat], req.log);
      return {
        ...flat,
        original,
        createdByDisplayName: flat.createdBy ? names.get(flat.createdBy) : undefined,
        lastEditByDisplayName: flat.lastEditBy ? names.get(flat.lastEditBy) : undefined,
      };
    });

    api.post("/nodes/:type/:id/rows", async (req, reply) => {
      const nc = ncFor(ctx, req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const params = req.params as { type: string; id: string };
      const type = nodeType(params.type);
      const id = Number(params.id);
      const parsed = dataSchema.safeParse(req.body ?? {});
      if (!type || !Number.isInteger(id) || id <= 0 || !parsed.success) {
        return reply.code(400).send({ error: "node must be view|table and a positive id" });
      }
      const data = parsed.data.data ?? {};
      try {
        const row =
          type === "view" ? await nc.createRowInView(id, data) : await nc.createRowInTable(id, data);
        return reply.code(201).send(flattenRow(row));
      } catch (e) {
        if (e instanceof NextcloudError) {
          return reply.code(e.status < 500 ? e.status : 502).send({ error: e.message });
        }
        throw e;
      }
    });

    api.delete("/nodes/:type/:id/rows/:rowId", async (req, reply) => {
      const nc = ncFor(ctx, req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const params = req.params as { type: string; id: string; rowId: string };
      const type = nodeType(params.type);
      const id = Number(params.id);
      const rowId = Number(params.rowId);
      if (!type || !Number.isInteger(id) || id <= 0 || !Number.isInteger(rowId) || rowId <= 0) {
        return reply.code(400).send({ error: "node must be view|table and a positive id" });
      }
      try {
        if (type === "view") await nc.deleteRowByView(id, rowId);
        else await nc.deleteRow(rowId);
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof NextcloudError && e.status === 404) {
          return reply.code(404).send({ error: "row not found" });
        }
        if (e instanceof NextcloudError) {
          return reply.code(e.status < 500 ? e.status : 502).send({ error: e.message });
        }
        throw e;
      }
    });
  },
};
