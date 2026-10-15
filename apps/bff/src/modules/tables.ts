import { z } from "zod";
import type { TablesColumn, TablesRow } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

export interface TableView {
  id: number;
  title: string;
  emoji?: string;
  columns: { id: number; title: string; type: string; subtype?: string }[];
  rows: { id: number; cells: Record<string, unknown> }[];
}

/** Flattens Tables' `data: [{columnId, value}]` into `cells: { [columnId]: value }`, resolving selection labels. */
export function toTableView(
  table: { id: number; title: string; emoji?: string },
  columns: TablesColumn[],
  rows: TablesRow[],
): TableView {
  const sorted = [...columns].sort((a, b) => (a.orderWeight ?? 0) - (b.orderWeight ?? 0));
  const labels = new Map<number, Map<number, string>>();
  for (const c of sorted) {
    if (c.selectionOptions?.length) {
      labels.set(c.id, new Map(c.selectionOptions.map((o) => [o.id, o.label])));
    }
  }
  return {
    id: table.id,
    title: table.title,
    emoji: table.emoji,
    columns: sorted.map(({ id, title, type, subtype }) => ({ id, title, type, subtype })),
    rows: rows.map((r) => ({
      id: r.id,
      cells: Object.fromEntries(
        r.data.map(({ columnId, value }) => [
          String(columnId),
          resolveValue(labels.get(columnId), value),
        ]),
      ),
    })),
  };
}

function resolveValue(options: Map<number, string> | undefined, value: unknown): unknown {
  if (!options) return value;
  const ids = Array.isArray(value) ? value : [value];
  const resolved = ids.map((v) => options.get(Number(v)) ?? v);
  return Array.isArray(value) ? resolved : resolved[0];
}

const configSchema = z.object({
  /** Numeric ID of the Nextcloud Tables table this module shows. Empty/missing = not configured. */
  TABLE_ID: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
});

export const tablesModule: BffModule<z.infer<typeof configSchema>> = {
  id: "tables",
  requires: ["nextcloud"],
  configSchema,
  register(api, ctx, config) {
    const { store, secrets, nextcloud } = ctx;

    api.get("/current", async (request, reply) => {
      if (config.TABLE_ID === undefined) {
        return reply.code(424).send({ error: "tables module not configured" });
      }
      const cred = store.getCredential(request.user.sub);
      if (!cred) return reply.code(424).send({ error: "nextcloud not connected" });
      const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
      const [table, columns, rows] = await Promise.all([
        nc.getTable(config.TABLE_ID),
        nc.getColumns(config.TABLE_ID),
        nc.getRows(config.TABLE_ID),
      ]);
      return toTableView(table, columns, rows);
    });
  },
};
