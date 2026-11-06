import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { listTables } from "../pg/catalog.js";
import { isAuthError, openPg, type PgClient, PgError, type PgOpen } from "../pg/client.js";
import { browseTable, deleteRow, insertRow, updateRow } from "../pg/table.js";
import { connectorCred } from "./connectors.js";
import type { BffModule } from "./types.js";

const SERVICE = "postges";

const configSchema = z.object({
  /** "true" (default) mounts only read routes; "false" adds insert/update/delete. */
  READ_ONLY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Upper bound for the rows page size (`limit` query param). */
  MAX_PAGE: z.coerce.number().int().min(1).max(1000).default(200),
  /** Connect + query timeout for upstream Postgres calls. */
  TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
});
type PostgesConfig = z.infer<typeof configSchema>;

const credentialsBody = z.object({ url: z.string().min(1) });
const rowsQuery = z.object({
  q: z.string().max(500).optional(),
  sort: z.string().max(200).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});
const pkBody = z.object({ pk: z.array(z.unknown()).min(1) });
const valuesBody = z.object({ values: z.record(z.string(), z.unknown()) });

/** postgres:// or postgresql:// connection string → credential-free display URL. */
function displayUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const port = u.port || "5432";
  return `${u.hostname}:${port}${u.pathname === "/" ? "" : u.pathname}`;
}

/**
 * Postgres admin module: per-user connection strings (sealed like every other
 * connector credential, D41) + a generic table browser over the `public`-style
 * schema catalog. Read-only unless MODULE_POSTGES_READ_ONLY=false — the BFF
 * never exposes write routes in read-only mode and upstream roles still apply.
 * The pg helpers in `src/pg/` are reusable by other modules.
 */
export const postgesModule: BffModule<PostgesConfig> = {
  id: SERVICE,
  configSchema,
  register(api, ctx, config) {
    const pgOpen: PgOpen = ctx.pgOpen ?? openPg;

    /** Runs `fn` on a fresh connection for the caller's stored credential. */
    async function withClient<T>(
      req: FastifyRequest,
      reply: FastifyReply,
      fn: (client: PgClient) => Promise<T>,
    ): Promise<T | undefined> {
      const cred = connectorCred(ctx, req.user.sub, SERVICE);
      if (!cred) {
        reply.code(424).send({ error: "postges is not connected" });
        return undefined;
      }
      let client: PgClient;
      try {
        client = await pgOpen(cred.secret, { timeoutMs: config.TIMEOUT_MS });
      } catch (err) {
        api.log.warn({ err }, "postges connect failed");
        reply.code(isAuthError(err) ? 401 : 502).send({ error: "postges unreachable" });
        return undefined;
      }
      try {
        return await fn(client);
      } catch (err) {
        if (err instanceof PgError) {
          reply.code(err.status).send({ error: err.message });
        } else {
          api.log.warn({ err }, "postges query failed");
          reply.code(isAuthError(err) ? 401 : 502).send({ error: "postges unreachable" });
        }
        return undefined;
      } finally {
        await client.end().catch(() => {});
      }
    }

    const tableRef = (req: FastifyRequest) => {
      const p = req.params as { schema: string; name: string };
      return { schema: p.schema, name: p.name };
    };

    api.get("/status", async (req) => {
      const cred = connectorCred(ctx, req.user.sub, SERVICE);
      return {
        connected: cred !== null,
        url: cred?.url ?? null,
        readOnly: config.READ_ONLY,
      };
    });

    api.post("/credentials", async (req, reply) => {
      const parsed = credentialsBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {url}" });
      const display = displayUrl(parsed.data.url);
      if (!display) {
        return reply.code(400).send({ error: "expected a postgres:// connection string" });
      }
      // Verify before sealing: open a connection and run a trivial query.
      let client: PgClient | undefined;
      try {
        client = await pgOpen(parsed.data.url, { timeoutMs: config.TIMEOUT_MS });
        await client.query("SELECT 1");
      } catch (err) {
        api.log.warn({ err }, "postges credential verify failed");
        return reply
          .code(isAuthError(err) ? 401 : 502)
          .send({ error: isAuthError(err) ? "invalid credential" : "postges unreachable" });
      } finally {
        await client?.end().catch(() => {});
      }
      ctx.store.saveServiceCredential({
        sub: req.user.sub,
        service: SERVICE,
        url: display,
        secretSealed: ctx.secrets.seal(parsed.data.url),
      });
      return { connected: true, url: display, readOnly: config.READ_ONLY };
    });

    api.delete("/credentials", async (req) => {
      ctx.store.deleteServiceCredential(req.user.sub, SERVICE);
      return { connected: false };
    });

    api.get("/tables", async (req, reply) => {
      const result = await withClient(req, reply, (c) => listTables(c));
      return result === undefined ? undefined : { tables: result };
    });

    api.get("/tables/:schema/:name/rows", async (req, reply) => {
      const query = rowsQuery.safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: "invalid query parameters" });
      const result = await withClient(req, reply, (c) =>
        browseTable(c, tableRef(req), {
          q: query.data.q,
          sort: query.data.sort,
          dir: query.data.dir,
          offset: query.data.offset,
          limit: query.data.limit,
          maxLimit: config.MAX_PAGE,
        }),
      );
      return result === undefined ? undefined : result;
    });

    if (!config.READ_ONLY) {
      api.post("/tables/:schema/:name/rows", async (req, reply) => {
        const body = valuesBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "expected {values: {...}}" });
        const row = await withClient(req, reply, (c) =>
          insertRow(c, tableRef(req), body.data.values),
        );
        return row === undefined ? undefined : reply.code(201).send({ row });
      });

      api.patch("/tables/:schema/:name/rows", async (req, reply) => {
        const pk = pkBody.safeParse(req.body);
        const values = valuesBody.safeParse(req.body);
        if (!pk.success || !values.success) {
          return reply.code(400).send({ error: "expected {pk: [...], values: {...}}" });
        }
        const row = await withClient(req, reply, (c) =>
          updateRow(c, tableRef(req), pk.data.pk, values.data.values),
        );
        return row === undefined ? undefined : { row };
      });

      api.delete("/tables/:schema/:name/rows", async (req, reply) => {
        const body = pkBody.safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: "expected {pk: [...]}" });
        const deleted = await withClient(req, reply, (c) =>
          deleteRow(c, tableRef(req), body.data.pk),
        );
        if (deleted === undefined) return undefined;
        if (!deleted) return reply.code(404).send({ error: "row not found" });
        return { deleted: true };
      });
    }
  },
};
