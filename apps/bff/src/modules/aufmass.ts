import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  TablesColumn,
  TablesContext,
  TablesContextNode,
  TablesRow,
} from "../nextcloud/client.js";
import { NextcloudError } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

const configSchema = z.object({
  /** Context (application) id from the Nextcloud Tables `/app/<id>` URL. Empty/missing = not configured. */
  APPLICATION_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  /** Title of the column holding the planned quantity — restmenge is computed only when both exist. */
  PLANNED_COLUMN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("Anz"),
  ),
  /** Title of the column holding the installed quantity (`Verbaut`). */
  VERBAUT_COLUMN: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("Verbaut"),
  ),
});

type NodeType = "view" | "table";

/** Synthetic read-only column id — negative ids never collide with Tables column ids. */
const RESTMENGE_COLUMN_ID = -1;

export interface AufmassApplication {
  name: string;
  nodes: { type: NodeType; id: number; title: string }[];
}

export interface AufmassView {
  kind: NodeType;
  id: number;
  title: string;
  emoji?: string;
  columns: {
    id: number;
    title: string;
    type: string;
    subtype?: string;
    options?: { id: number; label: string }[];
    /** BFF-computed read-only column (e.g. restmenge) — never editable. */
    computed?: boolean;
  }[];
  rows: {
    id: number;
    cells: Record<string, unknown>;
    createdAt?: string;
    createdBy?: string;
    lastEditAt?: string;
    lastEditBy?: string;
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

const colIdByTitle = (columns: { id: number; title: string }[], title: string) =>
  columns.find((c) => c.title.trim().toLowerCase() === title.trim().toLowerCase())?.id;

/** Restmenge (FR-008): appends a synthetic computed column planned − verbaut when both exist. */
function withRestmenge(view: AufmassView, config: z.infer<typeof configSchema>): AufmassView {
  const plannedId = colIdByTitle(view.columns, config.PLANNED_COLUMN);
  const verbautId = colIdByTitle(view.columns, config.VERBAUT_COLUMN);
  if (plannedId === undefined || verbautId === undefined) return view;
  return {
    ...view,
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

function toAufmassView(
  kind: NodeType,
  meta: { id: number; title: string; emoji?: string },
  columns: TablesColumn[],
  rows: TablesRow[],
): AufmassView {
  return {
    kind,
    id: meta.id,
    title: meta.title,
    emoji: meta.emoji,
    columns: columns.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      subtype: c.subtype,
      options: c.selectionOptions ?? undefined,
    })),
    rows: rows.map(flattenRow),
  };
}

export const aufmassModule: BffModule<z.infer<typeof configSchema>> = {
  id: "aufmass",
  requires: ["nextcloud"],
  configSchema,
  register(api: FastifyInstance, ctx, config) {
    const { store, secrets, nextcloud } = ctx;
    const nodeType = (s: string): NodeType | null =>
      s === "view" ? "view" : s === "table" ? "table" : null;
    /** Authenticated client for the caller, or null when Nextcloud is disconnected. */
    const ncFor = (sub: string) => {
      const cred = store.getCredential(sub);
      return cred
        ? nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed))
        : null;
    };

    api.get("/", async (req, reply) => {
      if (config.APPLICATION_ID === undefined) {
        return reply.code(424).send({ error: "aufmass application id not configured" });
      }
      const nc = ncFor(req.user!.sub);
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
      const nc = ncFor(req.user!.sub);
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
          return withRestmenge(toAufmassView("view", view, columns, rows), config);
        }
        const [table, columns, rows] = await Promise.all([
          nc.getTable(id),
          nc.getColumns(id),
          nc.getRows(id),
        ]);
        return withRestmenge(toAufmassView("table", table, columns, rows), config);
      } catch (e) {
        if (e instanceof NextcloudError && e.status === 404) {
          return reply.code(404).send({ error: "node not found" });
        }
        throw e;
      }
    });

    const dataSchema = z.object({ data: z.record(z.string(), z.unknown()).optional() }).strict();
    const toData = (cells: Record<string, unknown>) =>
      Object.entries(cells).map(([k, v]) => ({ columnId: Number(k), value: v }));

    api.patch("/rows/:rowId", async (req, reply) => {
      const nc = ncFor(req.user!.sub);
      if (!nc) {
        return reply.code(424).send({ error: "nextcloud is not connected" });
      }
      const rowId = Number((req.params as { rowId: string }).rowId);
      const parsed = dataSchema.safeParse(req.body ?? {});
      if (!Number.isInteger(rowId) || rowId <= 0 || !parsed.success) {
        return reply.code(400).send({ error: "expected {data: {columnId: value}}" });
      }
      const row = await nc.updateRow(rowId, toData(parsed.data.data ?? {}));
      const flat = flattenRow(row);
      // Recompute restmenge so the client can swap the row in without a refetch;
      // a failing column fetch must not block the update response.
      try {
        const cols = await nc.getColumns(row.tableId);
        const plannedId = colIdByTitle(cols, config.PLANNED_COLUMN);
        const verbautId = colIdByTitle(cols, config.VERBAUT_COLUMN);
        if (plannedId !== undefined && verbautId !== undefined) {
          flat.cells[String(RESTMENGE_COLUMN_ID)] = restOf(
            flat.cells[String(plannedId)],
            flat.cells[String(verbautId)],
          );
        }
      } catch (e) {
        req.log.warn({ err: String(e) }, "aufmass restmenge recompute failed");
      }
      return flat;
    });

    api.post("/nodes/:type/:id/rows", async (req, reply) => {
      const nc = ncFor(req.user!.sub);
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
      const data = toData(parsed.data.data ?? {});
      const row =
        type === "view" ? await nc.createRowInView(id, data) : await nc.createRowInTable(id, data);
      return reply.code(201).send(flattenRow(row));
    });

    api.delete("/nodes/:type/:id/rows/:rowId", async (req, reply) => {
      const nc = ncFor(req.user!.sub);
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
        throw e;
      }
    });
  },
};
