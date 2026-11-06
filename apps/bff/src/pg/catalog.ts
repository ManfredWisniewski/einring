import { type PgClient, PgError, quoteIdent } from "./client.js";

export interface PgColumn {
  name: string;
  /** information_schema `data_type`, e.g. "integer", "text", "timestamp with time zone". */
  type: string;
  /** Internal udt (e.g. pgvector `vector`) — never rendered, searched or written. */
  internal: boolean;
  nullable: boolean;
  /** 1-based position inside the primary key; 0 when the column is not part of it. */
  pk: number;
}

export interface PgTableRef {
  schema: string;
  name: string;
}

export interface PgTableInfo extends PgTableRef {
  kind: "table" | "view" | "materialized view";
  /** Planner row estimate (pg_class.reltuples) — cheap, not exact. */
  rowEstimate: number;
}

/** udts whose values are opaque payloads — hidden from browse/search/write. */
const INTERNAL_UDTS = new Set(["vector"]);

/** All user tables/views/materialized views outside system schemas. */
export async function listTables(client: PgClient): Promise<PgTableInfo[]> {
  const rows = await client.query<{
    schema: string;
    name: string;
    kind: string;
    estimate: number | string;
  }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind,
            GREATEST(c.reltuples, 0)::bigint AS estimate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p', 'v', 'm')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
     ORDER BY n.nspname, c.relname`,
  );
  const kindOf = (k: string): PgTableInfo["kind"] =>
    k === "v" ? "view" : k === "m" ? "materialized view" : "table";
  return rows.map((r) => ({
    schema: r.schema,
    name: r.name,
    kind: kindOf(r.kind),
    rowEstimate: Number(r.estimate),
  }));
}

/**
 * Columns of one table in ordinal order, with primary-key positions.
 * Throws PgError(404) when the relation does not exist (or the role can't see it).
 */
export async function tableColumns(client: PgClient, ref: PgTableRef): Promise<PgColumn[]> {
  const cols = await client.query<{
    name: string;
    type: string;
    udt: string;
    nullable: string;
  }>(
    `SELECT column_name AS name, data_type AS type, udt_name AS udt, is_nullable AS nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [ref.schema, ref.name],
  );
  if (cols.length === 0) {
    throw new PgError(404, `no such table: ${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`);
  }
  const pks = await client.query<{ name: string; pos: number }>(
    `SELECT kcu.column_name AS name, kcu.ordinal_position AS pos
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2
     ORDER BY kcu.ordinal_position`,
    [ref.schema, ref.name],
  );
  const pkPos = new Map(pks.map((p) => [p.name, Number(p.pos)]));
  return cols.map((c) => ({
    name: c.name,
    type: c.type,
    internal: INTERNAL_UDTS.has(c.udt),
    nullable: c.nullable === "YES",
    pk: pkPos.get(c.name) ?? 0,
  }));
}
