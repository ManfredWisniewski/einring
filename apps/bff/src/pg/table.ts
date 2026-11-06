import { type PgColumn, type PgTableRef, tableColumns } from "./catalog.js";
import { type PgClient, PgError, quoteIdent } from "./client.js";

/** information_schema data_types a free-text `ILIKE` search covers. */
const SEARCHABLE_TYPES = new Set([
  "text",
  "character varying",
  "character",
  "name",
  "citext",
  "uuid",
]);

const MAX_LIMIT = 1000;

export interface BrowseOptions {
  /** Free-text filter across searchable columns (ILIKE). */
  q?: string;
  /** Column name to sort by — must exist; defaults to first pk column, else first column. */
  sort?: string;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
  /** Hard cap for `limit` — the module passes its configured page size. */
  maxLimit: number;
}

export interface BrowseResult {
  columns: PgColumn[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
}

/** `%`/`_`/`\` are literal inside an ILIKE pattern escaped with ESCAPE '\'. */
function escapeLike(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** Row values as JSON-safe data: bytea becomes `\x<hex>`, internals become null. */
export function serializeRow(
  row: Record<string, unknown>,
  internal: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (internal.has(k)) {
      out[k] = null;
    } else if (v instanceof Uint8Array) {
      out[k] = `\\x${Buffer.from(v).toString("hex")}`;
    } else if (typeof v === "bigint") {
      // JSON.stringify can't serialize bigint — safe ints become numbers, rest strings.
      out[k] =
        v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(v)
          : v.toString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

const qualified = (ref: PgTableRef) => `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`;

function pkColumns(columns: PgColumn[]): PgColumn[] {
  return columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
}

function checkValues(columns: PgColumn[], values: Record<string, unknown>): void {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const bad = Object.keys(values).filter((k) => {
    const c = byName.get(k);
    return c === undefined || c.internal;
  });
  if (bad.length) throw new PgError(400, `unknown or internal column(s): ${bad.join(", ")}`);
}

/** Paginated, searchable row listing for one relation. */
export async function browseTable(
  client: PgClient,
  ref: PgTableRef,
  opts: BrowseOptions,
): Promise<BrowseResult> {
  const columns = await tableColumns(client, ref);
  const params: unknown[] = [];
  const where: string[] = [];

  const searchCols = columns.filter((c) => !c.internal && SEARCHABLE_TYPES.has(c.type));
  if (opts.q && searchCols.length > 0) {
    params.push(`%${escapeLike(opts.q)}%`);
    const ph = `$${params.length}`;
    where.push(
      `(${searchCols.map((c) => `${quoteIdent(c.name)}::text ILIKE ${ph} ESCAPE '\\'`).join(" OR ")})`,
    );
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const sortCol = columns.find((c) => c.name === opts.sort) ?? pkColumns(columns)[0] ?? columns[0];
  if (!sortCol) throw new PgError(404, "empty table");
  const dir = opts.dir === "desc" ? "DESC" : "ASC";

  const totalRows = await client.query<{ n: number | string }>(
    `SELECT count(*) AS n FROM ${qualified(ref)}${whereSql}`,
    params,
  );
  const total = Number(totalRows[0]?.n ?? 0);

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), Math.min(opts.maxLimit, MAX_LIMIT));
  const offset = Math.max(opts.offset ?? 0, 0);
  params.push(limit, offset);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT ${columns.map((c) => quoteIdent(c.name)).join(", ")}
     FROM ${qualified(ref)}${whereSql}
     ORDER BY ${quoteIdent(sortCol.name)} ${dir}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const internal = new Set(columns.filter((c) => c.internal).map((c) => c.name));
  return {
    columns,
    rows: rows.map((r) => serializeRow(r, internal)),
    total,
    offset,
    limit,
  };
}

/** INSERT one row; returns the inserted row (RETURNING *). */
export async function insertRow(
  client: PgClient,
  ref: PgTableRef,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const columns = await tableColumns(client, ref);
  checkValues(columns, values);
  const names = Object.keys(values);
  if (names.length === 0) throw new PgError(400, "no values to insert");
  const params = names.map((n) => values[n]);
  const rows = await client.query<Record<string, unknown>>(
    `INSERT INTO ${qualified(ref)} (${names.map(quoteIdent).join(", ")})
     VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})
     RETURNING *`,
    params,
  );
  if (rows[0] === undefined) throw new PgError(500, "insert returned no row");
  const internal = new Set(columns.filter((c) => c.internal).map((c) => c.name));
  return serializeRow(rows[0], internal);
}

/** UPDATE by primary key; `values` must not contain pk or internal columns. */
export async function updateRow(
  client: PgClient,
  ref: PgTableRef,
  pkValues: unknown[],
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const columns = await tableColumns(client, ref);
  const pks = pkColumns(columns);
  if (pks.length === 0) throw new PgError(400, "table has no primary key");
  if (pkValues.length !== pks.length) {
    throw new PgError(400, `expected ${pks.length} primary-key value(s)`);
  }
  const pkNames = new Set(pks.map((c) => c.name));
  checkValues(columns, values);
  const setNames = Object.keys(values).filter((n) => !pkNames.has(n));
  if (setNames.length === 0) throw new PgError(400, "nothing to update");

  const params = [...setNames.map((n) => values[n]), ...pkValues];
  const setSql = setNames.map((n, i) => `${quoteIdent(n)} = $${i + 1}`).join(", ");
  const whereSql = pks
    .map((c, i) => `${quoteIdent(c.name)} = $${setNames.length + i + 1}`)
    .join(" AND ");
  const rows = await client.query<Record<string, unknown>>(
    `UPDATE ${qualified(ref)} SET ${setSql} WHERE ${whereSql} RETURNING *`,
    params,
  );
  if (rows[0] === undefined) throw new PgError(404, "row not found");
  const internal = new Set(columns.filter((c) => c.internal).map((c) => c.name));
  return serializeRow(rows[0], internal);
}

/** DELETE by primary key; resolves false when no row matched. */
export async function deleteRow(
  client: PgClient,
  ref: PgTableRef,
  pkValues: unknown[],
): Promise<boolean> {
  const columns = await tableColumns(client, ref);
  const pks = pkColumns(columns);
  if (pks.length === 0) throw new PgError(400, "table has no primary key");
  if (pkValues.length !== pks.length) {
    throw new PgError(400, `expected ${pks.length} primary-key value(s)`);
  }
  const whereSql = pks.map((c, i) => `${quoteIdent(c.name)} = $${i + 1}`).join(" AND ");
  const rows = await client.query<{ deleted: number }>(
    `DELETE FROM ${qualified(ref)} WHERE ${whereSql} RETURNING 1 AS deleted`,
    pkValues,
  );
  return rows.length > 0;
}
