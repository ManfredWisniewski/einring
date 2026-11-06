import postgres from "postgres";

/**
 * Minimal Postgres client surface the einring pg helpers need. The default
 * implementation is postgres.js (`postgres` package); tests inject a fake via
 * `AppDeps.pgOpen`. One short-lived connection per `openPg` call — admin/browse
 * volume is low and credentials are per-user, so no pooling across requests.
 */
export interface PgClient {
  /** Runs a parameterized query ($1, $2, …) and resolves with row objects. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

export interface PgOpenOptions {
  /** Connect + per-query timeout in milliseconds. */
  timeoutMs?: number;
}

export type PgOpen = (url: string, opts?: PgOpenOptions) => Promise<PgClient>;

/** HTTP-mappable failure: `status` is the code the BFF route answers with. */
export class PgError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PgError";
  }
}

/** Quotes one SQL identifier — schema, table or column name. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** postgres.js surfaces SQLSTATE on `code` (e.g. 28P01 = invalid password). */
export function isAuthError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code).startsWith("28")
    : false;
}

export const openPg: PgOpen = async (url, opts = {}) => {
  const timeoutS = Math.max(1, Math.ceil((opts.timeoutMs ?? 10_000) / 1000));
  const sql = postgres(url, {
    max: 1,
    connect_timeout: timeoutS,
    query_timeout: timeoutS,
    idle_timeout: 5,
    max_lifetime: 60,
  });
  return {
    query: async <T>(text: string, params?: unknown[]) =>
      (await sql.unsafe(text, params as never[])) as unknown as T[],
    end: () => sql.end({ timeout: 5 }),
  };
};
