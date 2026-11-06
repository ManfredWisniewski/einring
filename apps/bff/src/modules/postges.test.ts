import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { createSecretBox } from "../crypto.js";
import type { PgClient } from "../pg/client.js";
import { testApp, testEnv } from "../test-utils.js";

const CONN = "postgres://alice:s3cret@db.test:5432/shop";

interface FakePg extends PgClient {
  queries: { text: string; params: unknown[] }[];
}

/** Scripted pg client: answers the catalog/browse/mutation queries postges issues. */
function fakePg(overrides: Partial<Record<string, unknown[]>> = {}): FakePg {
  const queries: { text: string; params: unknown[] }[] = [];
  const cols = [
    { name: "id", type: "integer", udt: "int4", nullable: "NO" },
    { name: "title", type: "text", udt: "text", nullable: "NO" },
    { name: "price", type: "numeric", udt: "numeric", nullable: "YES" },
    { name: "embedding", type: "USER-DEFINED", udt: "vector", nullable: "YES" },
  ];
  const answer = (text: string): unknown[] => {
    if (text.includes("information_schema.columns")) return cols;
    if (text.includes("key_column_usage")) return [{ name: "id", pos: 1 }];
    if (text.includes("pg_class")) {
      return [
        { schema: "public", name: "items", kind: "r", estimate: "42" },
        { schema: "public", name: "items_view", kind: "v", estimate: "0" },
      ];
    }
    if (text.startsWith("SELECT count(*)")) return [{ n: overrides.count ?? 2 }];
    if (text.includes('FROM "public"."items"')) {
      return (
        overrides.rows ?? [
          { id: 1, title: "Hammer", price: 9.5, embedding: null },
          { id: 2, title: "Nail", price: 0.1, embedding: null },
        ]
      );
    }
    if (text.startsWith("INSERT INTO")) {
      return [{ id: 3, title: "Screw", price: 0.2, embedding: null }];
    }
    if (text.startsWith("UPDATE")) {
      return overrides.updateRows ?? [{ id: 1, title: "Hammer!", price: 9.5, embedding: null }];
    }
    if (text.startsWith("DELETE FROM")) return [{ deleted: 1 }];
    return [{}]; // SELECT 1 etc.
  };
  return {
    queries,
    query: async <T>(text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      return answer(text) as T[];
    },
    end: async () => {},
  };
}

async function connectedApp(pg: FakePg, env: Record<string, string> = {}) {
  const merged = { ...testEnv(), ...env };
  const { app, store, auth } = await testApp({
    pgOpen: async () => pg,
    config: loadConfig(merged),
    // testApp seals with testConfig()'s key — override secrets to match our env.
    secrets: createSecretBox(merged.ENCRYPTION_KEY ?? ""),
  });
  await app.inject({
    method: "POST",
    url: "/api/postges/credentials",
    headers: auth,
    payload: { url: CONN },
  });
  return { app, store, auth, env: merged };
}

describe("postges module", () => {
  it("reports disconnected status and rejects data routes with 424", async () => {
    const { app, auth } = await testApp({ pgOpen: async () => fakePg() });
    const status = await app.inject({ url: "/api/postges/status", headers: auth });
    expect(status.json()).toEqual({ connected: false, url: null, readOnly: true });
    const tables = await app.inject({ url: "/api/postges/tables", headers: auth });
    expect(tables.statusCode).toBe(424);
  });

  it("verifies and stores a postgres:// credential without leaking the secret", async () => {
    const pg = fakePg();
    const { app, store, auth, env } = await connectedApp(pg);
    const res = await app.inject({
      method: "POST",
      url: "/api/postges/credentials",
      headers: auth,
      payload: { url: CONN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      connected: true,
      url: "db.test:5432/shop",
      readOnly: true,
    });
    // The sealed secret opens back to the full connection string; the url column has no creds.
    const cred = store.getServiceCredential("user-1", "postges");
    expect(cred?.url).toBe("db.test:5432/shop");
    const secrets = createSecretBox(env.ENCRYPTION_KEY ?? "");
    expect(secrets.open(cred!.secretSealed)).toBe(CONN);
    expect(JSON.stringify(res.json())).not.toContain("s3cret");
  });

  it("rejects non-postgres urls and failed verification", async () => {
    const { app, auth } = await testApp({ pgOpen: async () => fakePg() });
    const bad = await app.inject({
      method: "POST",
      url: "/api/postges/credentials",
      headers: auth,
      payload: { url: "https://example.com" },
    });
    expect(bad.statusCode).toBe(400);
    const { app: app2, auth: auth2 } = await testApp({
      pgOpen: async () => {
        throw new Error("connect timeout");
      },
    });
    const fail = await app2.inject({
      method: "POST",
      url: "/api/postges/credentials",
      headers: auth2,
      payload: { url: CONN },
    });
    expect(fail.statusCode).toBe(502);
  });

  it("lists tables and browses rows with search/sort/pagination", async () => {
    const pg = fakePg();
    const { app, auth } = await connectedApp(pg);

    const tables = await app.inject({ url: "/api/postges/tables", headers: auth });
    expect(tables.statusCode).toBe(200);
    expect(tables.json().tables).toHaveLength(2);
    expect(tables.json().tables[0]).toMatchObject({
      schema: "public",
      name: "items",
      kind: "table",
    });

    const rows = await app.inject({
      url: "/api/postges/tables/public/items/rows?q=ham&sort=price&dir=desc&limit=10",
      headers: auth,
    });
    expect(rows.statusCode).toBe(200);
    const body = rows.json();
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.columns.find((c: { name: string }) => c.name === "embedding").internal).toBe(true);
    // internal columns are never rendered
    expect(body.rows[0].embedding).toBeNull();

    const searchQ = pg.queries.find((q) => q.text.includes("ILIKE"));
    expect(searchQ?.params[0]).toBe("%ham%");
    const orderQ = pg.queries.find((q) => q.text.includes('ORDER BY "price"'));
    expect(orderQ?.text).toContain('"price" DESC');
  });

  it("hides write routes in read-only mode (default)", async () => {
    const { app, auth } = await connectedApp(fakePg());
    const res = await app.inject({
      method: "POST",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { values: { title: "x" } },
    });
    expect(res.statusCode).toBe(404);
  });

  it("supports insert/update/delete when MODULE_POSTGES_READ_ONLY=false", async () => {
    const pg = fakePg();
    const { app, auth } = await connectedApp(pg, { MODULE_POSTGES_READ_ONLY: "false" });
    const status = await app.inject({ url: "/api/postges/status", headers: auth });
    expect(status.json().readOnly).toBe(false);

    const ins = await app.inject({
      method: "POST",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { values: { title: "Screw", price: 0.2 } },
    });
    expect(ins.statusCode).toBe(201);
    expect(ins.json().row.id).toBe(3);

    const upd = await app.inject({
      method: "PATCH",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { pk: [1], values: { title: "Hammer!" } },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().row.title).toBe("Hammer!");

    const bad = await app.inject({
      method: "PATCH",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { pk: [1, 2], values: { title: "x" } },
    });
    expect(bad.statusCode).toBe(400);

    const unknownCol = await app.inject({
      method: "POST",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { values: { nope: 1 } },
    });
    expect(unknownCol.statusCode).toBe(400);

    const internalCol = await app.inject({
      method: "POST",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { values: { embedding: "[1,2,3]" } },
    });
    expect(internalCol.statusCode).toBe(400);

    const del = await app.inject({
      method: "DELETE",
      url: "/api/postges/tables/public/items/rows",
      headers: auth,
      payload: { pk: [2] },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
  });

  it("answers 404 for unknown tables", async () => {
    const pg = fakePg();
    const orig = pg.query.bind(pg);
    pg.query = async <T>(text: string, params?: unknown[]) => {
      if (text.includes("information_schema.columns")) return [] as T[];
      return orig(text, params) as Promise<T[]>;
    };
    const { app, auth } = await connectedApp(pg);
    const res = await app.inject({
      url: "/api/postges/tables/public/missing/rows",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
