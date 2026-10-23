import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "./app.js";
import { createCompositeVerifier, createSessionVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import type { SecretBox } from "./crypto.js";
import { openStore, type Store } from "./db.js";
import type { ImapOpen } from "./modules/email.js";
import { fakeFetch, json, TEST_USER, testApp, testEnv } from "./test-utils.js";

describe("auth", () => {
  it("rejects requests without a bearer token", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects invalid tokens", async () => {
    const { app } = await testApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns the user for a valid token", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/me", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TEST_USER);
  });

  it("healthz is public", async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("instance config", () => {
  it("serves the instance name and OIDC client settings without auth", async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "Einring",
      authentik: {
        issuer: "https://auth.test/application/o/einring/",
        clientId: "einring-client",
      },
    });
  });

  it("exposes whitelabel tagline and css vars when configured", async () => {
    const { app } = await testApp({
      config: loadConfig({
        ...testEnv(),
        INSTANCE_NAME: "Portal",
        INSTANCE_TAGLINE: "",
        INSTANCE_CSS_VARS: '{"--accent-base":"#b91c1c","--accent-subtle":"#fee2e2"}',
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.json()).toEqual({
      name: "Portal",
      tagline: "",
      cssVars: { "--accent-base": "#b91c1c", "--accent-subtle": "#fee2e2" },
      authentik: {
        issuer: "https://auth.test/application/o/einring/",
        clientId: "einring-client",
      },
    });
  });

  it("exposes the named theme when INSTANCE_THEME is set", async () => {
    const { app } = await testApp({
      config: loadConfig({ ...testEnv(), INSTANCE_THEME: "wuttke" }),
    });
    const res = await app.inject({ method: "GET", url: "/api/config" });
    expect(res.json()).toEqual({
      name: "Einring",
      authentik: {
        issuer: "https://auth.test/application/o/einring/",
        clientId: "einring-client",
      },
      theme: expect.objectContaining({
        light: expect.objectContaining({ "--accent-base": "#1e73be" }),
        dark: expect.objectContaining({ "--surface-base": "#000000" }),
      }),
    });
  });

  it("fails config on an unknown or malformed INSTANCE_THEME", () => {
    expect(() => loadConfig({ ...testEnv(), INSTANCE_THEME: "nope" })).toThrow(
      /INSTANCE_THEME: no theme file for "nope"/,
    );
    expect(() => loadConfig({ ...testEnv(), INSTANCE_THEME: "../etc/passwd" })).toThrow(
      /INSTANCE_THEME/,
    );
  });

  it("fails config on malformed INSTANCE_CSS_VARS", () => {
    expect(() => loadConfig({ ...testEnv(), INSTANCE_CSS_VARS: "not json" })).toThrow(
      /INSTANCE_CSS_VARS/,
    );
    expect(() => loadConfig({ ...testEnv(), INSTANCE_CSS_VARS: '{"color":"red"}' })).toThrow(
      /not a --css-variable/,
    );
    expect(() => loadConfig({ ...testEnv(), INSTANCE_CSS_VARS: '{"--x":"a;</style>"}' })).toThrow(
      /not a safe CSS value/,
    );
  });

  it("injects INSTANCE_NAME into the served index.html title", async () => {
    const dir = await mkdtemp(join(tmpdir(), "einring-static-"));
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><html><head><title>Einring</title></head><body></body></html>",
    );
    const { app } = await testApp({
      config: loadConfig({
        ...testEnv(),
        INSTANCE_NAME: "Mordor <Ops>",
        INSTANCE_CSS_VARS: '{"--accent-base":"#b91c1c"}',
        STATIC_DIR: dir,
      }),
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Mordor &lt;Ops&gt;</title>");
    expect(res.body).toContain("<style>:root{--accent-base:#b91c1c}</style></head>");
    await rm(dir, { recursive: true });
  });

  it("injects theme vars scoped per color scheme into index.html", async () => {
    const dir = await mkdtemp(join(tmpdir(), "einring-static-"));
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><html><head><title>Einring</title></head><body></body></html>",
    );
    const { app } = await testApp({
      config: loadConfig({ ...testEnv(), INSTANCE_THEME: "wuttke", STATIC_DIR: dir }),
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.body).toContain(":root{");
    expect(res.body).toContain("--surface-base:#f5f5f5");
    expect(res.body).toContain('[data-theme="dark"]{');
    expect(res.body).toContain("--surface-base:#000000");
    // SPA fallback gets the same patched document
    const spa = await app.inject({ method: "GET", url: "/wiki" });
    expect(spa.body).toContain("--surface-base:#000000");
    await rm(dir, { recursive: true });
  });
});

describe("nextcloud login flow", () => {
  const LOGIN_URL = "https://cloud.test/login/v2/flow/abc";
  const POLL_URL = "https://cloud.test/login/v2/poll";

  function nextcloudFake(state: { finished: boolean }) {
    return fakeFetch((url, init) => {
      if (url === "https://cloud.test/index.php/login/v2" && init?.method === "POST") {
        return json({ poll: { token: "poll-token", endpoint: POLL_URL }, login: LOGIN_URL });
      }
      if (url === POLL_URL) {
        expect(String(init?.body)).toBe("token=poll-token");
        return state.finished
          ? json({ server: "https://cloud.test", loginName: "frodo", appPassword: "app-pw-secret" })
          : new Response("", { status: 404 });
      }
      if (url === "https://cloud.test/ocs/v2.php/cloud/user") {
        return json({
          ocs: { meta: { status: "ok", statuscode: 200 }, data: { displayname: "Frodo B." } },
        });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
  }

  it("starts disconnected, stays pending until Nextcloud completes, then is connected", async () => {
    const state = { finished: false };
    const { app, auth, store } = await testApp({ fetchImpl: nextcloudFake(state) });

    let res = await app.inject({ method: "GET", url: "/api/nextcloud/connection", headers: auth });
    expect(res.json()).toEqual({ status: "disconnected" });

    res = await app.inject({ method: "POST", url: "/api/nextcloud/login-flow", headers: auth });
    expect(res.json()).toEqual({ login: LOGIN_URL });

    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      headers: auth,
    });
    expect(res.json().status).toBe("pending");

    state.finished = true;
    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      headers: auth,
    });
    expect(res.json()).toEqual({
      status: "connected",
      loginName: "frodo",
      displayName: "Frodo B.",
      server: "https://cloud.test",
    });

    const stored = store.getCredential(TEST_USER.sub);
    expect(stored?.appPasswordSealed).toBeDefined();
    expect(stored?.appPasswordSealed).not.toContain("app-pw-secret");
    expect(JSON.stringify(res.json())).not.toContain("app-pw-secret");

    res = await app.inject({ method: "DELETE", url: "/api/nextcloud/connection", headers: auth });
    expect(res.statusCode).toBe(204);
    expect(store.getCredential(TEST_USER.sub)).toBeUndefined();
  });

  it("poll without a pending flow answers 409", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("embedded login flow (anonymous)", () => {
  const LOGIN_URL = "https://cloud.test/login/v2/flow/abc";
  const POLL_URL = "https://cloud.test/login/v2/poll";

  function nextcloudFake(state: { finished: boolean }) {
    return fakeFetch((url, init) => {
      if (url === "https://cloud.test/index.php/login/v2" && init?.method === "POST") {
        return json({ poll: { token: "poll-token", endpoint: POLL_URL }, login: LOGIN_URL });
      }
      if (url === POLL_URL) {
        return state.finished
          ? json({ server: "https://cloud.test", loginName: "frodo", appPassword: "app-pw-secret" })
          : new Response("", { status: 404 });
      }
      if (url === "https://cloud.test/ocs/v2.php/cloud/user") {
        return json({
          ocs: { meta: { status: "ok", statuscode: 200 }, data: { displayname: "Frodo B." } },
        });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
  }

  /** App whose verifier accepts the test JWT and real session tokens. */
  async function embeddedApp(state: { finished: boolean }) {
    const store = openStore(":memory:");
    const { app, auth } = await testApp({
      store,
      fetchImpl: nextcloudFake(state),
      verifyToken: createCompositeVerifier(async (token) => {
        if (token !== "valid-token") throw new Error("bad token");
        return TEST_USER;
      }, createSessionVerifier(store.getSessionSub)),
    });
    return { app, store, auth };
  }

  it("mints a session on flow completion and accepts it on all routes", async () => {
    const state = { finished: false };
    const { app, store } = await embeddedApp(state);

    // No bearer: start returns a flow id instead of binding to a user sub.
    let res = await app.inject({ method: "POST", url: "/api/nextcloud/login-flow" });
    expect(res.statusCode).toBe(200);
    const { login, flow } = res.json() as { login: string; flow?: string };
    expect(login).toBe(LOGIN_URL);
    expect(flow).toBeTruthy();
    expect(store.getPendingFlow(`flow:${flow}`)).toBeDefined();

    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      payload: { flow },
    });
    expect(res.json()).toEqual({ status: "pending", login: "" });

    state.finished = true;
    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      payload: { flow },
    });
    const body = res.json() as { status: string; sessionToken?: string };
    expect(body.status).toBe("connected");
    expect(body.sessionToken).toBeTruthy();
    // The app password never leaves the BFF — not in the session response either.
    expect(JSON.stringify(body)).not.toContain("app-pw-secret");

    const sessionAuth = { authorization: `Bearer ${body.sessionToken}` };
    res = await app.inject({ method: "GET", url: "/api/me", headers: sessionAuth });
    expect(res.json()).toEqual({ sub: "nc:frodo" });
    res = await app.inject({
      method: "GET",
      url: "/api/nextcloud/connection",
      headers: sessionAuth,
    });
    expect(res.json()).toEqual({
      status: "connected",
      loginName: "frodo",
      displayName: "Frodo B.",
      server: "https://cloud.test",
    });
    expect(store.getCredential("nc:frodo")?.appPasswordSealed).toBeDefined();
  });

  it("poll without a flow id answers 400; unknown flow id answers 409", async () => {
    const { app } = await embeddedApp({ finished: false });
    let res = await app.inject({ method: "POST", url: "/api/nextcloud/login-flow/poll" });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      payload: { flow: "bogus" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("an authed caller's flow still binds to their own sub (no session minted)", async () => {
    const state = { finished: true };
    const { app, auth, store } = await embeddedApp(state);
    let res = await app.inject({ method: "POST", url: "/api/nextcloud/login-flow", headers: auth });
    expect(res.json()).toEqual({ login: LOGIN_URL }); // no flow id for authed starts
    res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      headers: auth,
    });
    const body = res.json() as { status: string; sessionToken?: string };
    expect(body.status).toBe("connected");
    expect(body.sessionToken).toBeUndefined();
    expect(store.getCredential(TEST_USER.sub)).toBeDefined();
    expect(store.getCredential("nc:frodo")).toBeUndefined();
  });

  it("disconnecting deletes the session — a dead token gets 401", async () => {
    const state = { finished: true };
    const { app } = await embeddedApp(state);
    const { flow } = (
      await app.inject({ method: "POST", url: "/api/nextcloud/login-flow" })
    ).json() as { flow: string };
    const res = await app.inject({
      method: "POST",
      url: "/api/nextcloud/login-flow/poll",
      payload: { flow },
    });
    const sessionAuth = { authorization: `Bearer ${res.json().sessionToken}` };
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: sessionAuth })).statusCode,
    ).toBe(200);
    await app.inject({
      method: "DELETE",
      url: "/api/nextcloud/connection",
      headers: sessionAuth,
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/me", headers: sessionAuth })).statusCode,
    ).toBe(401);
  });

  it("serves index.html with frame-ancestors for the configured Nextcloud origin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "einring-static-"));
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><html><head><title>Einring</title></head><body></body></html>",
    );
    const { app } = await testApp({
      config: loadConfig({ ...testEnv(), STATIC_DIR: dir }),
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.headers["content-security-policy"]).toBe(
      "frame-ancestors 'self' https://cloud.test",
    );
    await rm(dir, { recursive: true });
  });
});

describe("tables", () => {
  const V1 = "/index.php/apps/tables/api/1";
  const CTX = "/ocs/v2.php/apps/tables/api/2/contexts";
  const ocs = (data: unknown, status = 200) =>
    json({ ocs: { meta: { status: "ok", statuscode: status }, data } }, status);

  const columns = [
    { id: 2, title: "Done", type: "selection", subtype: "check", orderWeight: 1 },
    {
      id: 4,
      title: "Status",
      type: "selection",
      orderWeight: 2,
      selectionOptions: [
        { id: 0, label: "open" },
        { id: 1, label: "closed" },
      ],
    },
    { id: 1, title: "Name", type: "text", subtype: "line", orderWeight: 0 },
  ];
  const row10 = {
    id: 10,
    tableId: 7,
    data: [
      { columnId: 1, value: "Ring" },
      { columnId: 2, value: true },
      { columnId: 4, value: 0 },
    ],
  };

  /** Full application fake: context 3 with a view node and a table node. */
  const appFetch = (seen?: { puts?: { url: string; body: unknown }[]; deletes?: string[] }) =>
    fakeFetch((url, init) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authHeader).toBe(`Basic ${Buffer.from("frodo:app-pw").toString("base64")}`);
      if (url.endsWith(`${CTX}/3`)) {
        // Real shape (verified against cloud.wit.gmbh): `nodes` is an id-keyed
        // map of ContextNodeRelation with snake_case fields — no titles.
        return ocs({
          id: 3,
          name: "Field Ops",
          nodes: {
            12: { id: 12, context_id: 3, node_id: 5, node_type: 1, permissions: 31 },
            13: { id: 13, context_id: 3, node_id: 7, node_type: 0, permissions: 31 },
            14: { id: 14, context_id: 3, node_id: 9, node_type: 7, permissions: 31 },
          },
          pages: {
            1: {
              id: 1,
              context_id: 3,
              page_type: "startpage",
              content: { 7: { order: 10, node_rel_id: 12 } },
            },
          },
        });
      }
      if (url.endsWith(`${V1}/views/5`)) {
        return json({ id: 5, title: "Open items", emoji: "👀", tableId: 7 });
      }
      if (url.endsWith(`${V1}/views/5/columns`)) return json(columns);
      if (url.endsWith(`${V1}/views/5/rows`) && init?.method === "GET") return json([row10]);
      if (url.endsWith(`${V1}/views/5/rows`) && init?.method === "POST") {
        return json({ ...row10, id: 11, data: [] }, 201);
      }
      if (url.endsWith(`${V1}/tables/7`) && init?.method === "GET") {
        return json({ id: 7, title: "All items", emoji: "📦" });
      }
      if (url.endsWith(`${V1}/tables/7/columns`)) return json(columns);
      if (url.endsWith(`${V1}/tables/7/rows`) && init?.method === "GET") return json([row10]);
      if (url.endsWith(`${V1}/tables/7/rows`) && init?.method === "POST") {
        return json({ ...row10, id: 11, data: [] }, 201);
      }
      if (url.endsWith(`${V1}/rows/10`) && init?.method === "PUT") {
        seen?.puts?.push({ url, body: JSON.parse(String(init?.body)) });
        return json({
          ...row10,
          data: [
            { columnId: 1, value: "Ring" },
            { columnId: 2, value: false },
            { columnId: 4, value: 0 },
          ],
        });
      }
      if (url.endsWith(`${V1}/views/5/rows/10`) && init?.method === "DELETE") {
        seen?.deletes?.push(url);
        return json({}, 200);
      }
      if (url.endsWith(`${V1}/rows/10`) && init?.method === "DELETE") {
        seen?.deletes?.push(url);
        return json({}, 200);
      }
      return json({ error: `unexpected ${init?.method ?? "GET"} ${url}` }, 500);
    });

  it("answers 424 when the application id is not configured", async () => {
    const env = testEnv();
    delete env.MODULE_TABLES_APPLICATION_ID;
    const { app, auth } = await testApp({ config: loadConfig(env) });
    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth });
    expect(res.statusCode).toBe(424);
    expect(res.json().error).toMatch(/not configured/);
  });

  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth });
    expect(res.statusCode).toBe(424);
  });

  it("lists the application's views and tables from the v2 context", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: appFetch() });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "Field Ops",
      nodes: [
        { type: "view", id: 5, title: "Open items" },
        { type: "table", id: 7, title: "All items" },
      ],
    });
  });

  it("returns a view node with columns and raw cells", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: appFetch() });
    connect(store, secrets);
    const res = await app.inject({
      method: "GET",
      url: "/api/tables/nodes/view/5",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      kind: "view",
      id: 5,
      title: "Open items",
      emoji: "👀",
      columns: [
        { id: 2, title: "Done", type: "selection", subtype: "check" },
        {
          id: 4,
          title: "Status",
          type: "selection",
          subtype: undefined,
          options: [
            { id: 0, label: "open" },
            { id: 1, label: "closed" },
          ],
        },
        { id: 1, title: "Name", type: "text", subtype: "line" },
      ],
      rows: [{ id: 10, cells: { "1": "Ring", "2": true, "4": 0 } }],
    });
  });

  it("returns a table node through table endpoints", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: appFetch() });
    connect(store, secrets);
    const res = await app.inject({
      method: "GET",
      url: "/api/tables/nodes/table/7",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("table");
    expect(res.json().title).toBe("All items");
  });

  it("updates, creates and deletes rows via the correct v1 routes", async () => {
    const seen: { puts: { url: string; body: unknown }[]; deletes: string[] } = {
      puts: [],
      deletes: [],
    };
    const { app, auth, store, secrets } = await testApp({ fetchImpl: appFetch(seen) });
    connect(store, secrets);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/tables/rows/10",
      headers: auth,
      payload: { data: { "2": false } },
    });
    expect(patch.statusCode).toBe(200);
    expect(seen.puts).toHaveLength(1);
    expect(seen.puts[0]!.url).toContain("/api/1/rows/10");
    expect(seen.puts[0]!.body).toEqual({ data: [{ columnId: 2, value: false }] });
    expect(patch.json().cells["2"]).toBe(false);

    const created = await app.inject({
      method: "POST",
      url: "/api/tables/nodes/view/5/rows",
      headers: auth,
      payload: {},
    });
    expect(created.statusCode).toBe(201);

    const delView = await app.inject({
      method: "DELETE",
      url: "/api/tables/nodes/view/5/rows/10",
      headers: auth,
    });
    expect(delView.statusCode).toBe(204);
    const delTable = await app.inject({
      method: "DELETE",
      url: "/api/tables/nodes/table/7/rows/10",
      headers: auth,
    });
    expect(delTable.statusCode).toBe(204);
    expect(seen.deletes[0]).toContain("/api/1/views/5/rows/10");
    expect(seen.deletes[1]).toContain("/api/1/rows/10");
  });

  it("rejects bad node ids and surfaces an upstream 404", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes("/api/1/views/999") ? json({ message: "not found" }, 404) : appFetch()(url),
    );
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);

    expect(
      (await app.inject({ method: "GET", url: "/api/tables/nodes/folder/5", headers: auth }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/tables/nodes/view/abc", headers: auth }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/api/tables/nodes/view/999", headers: auth }))
        .statusCode,
    ).toBe(404);
  });
});

const connect = (store: Store, secrets: SecretBox) =>
  store.saveCredential({
    sub: TEST_USER.sub,
    server: "https://cloud.test",
    loginName: "frodo",
    appPasswordSealed: secrets.seal("app-pw"),
  });

describe("monitor", () => {
  const ocs = (data: unknown) => json({ ocs: { meta: { status: "ok", statuscode: 200 }, data } });

  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/monitor/server", headers: auth })).statusCode,
    ).toBe(424);
    expect(
      (await app.inject({ method: "GET", url: "/api/monitor/talk-status", headers: auth }))
        .statusCode,
    ).toBe(424);
  });

  it("returns trimmed server health", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes("/apps/serverinfo/api/v1/info")
        ? ocs({
            nextcloud: { system: { version: "31.0.0" }, storage: { num_users: 42 } },
            server: {
              webserver: "nginx",
              php: { version: "8.3.1" },
              database: { type: "mysql", version: "10.11", size: 1234 },
            },
            system: {
              cpuload: [0.1, 0.2, 0.3],
              mem_total: 1000,
              mem_free: 400,
              freespace: 99999,
              apps: { num_installed: 30, num_updates_available: 2 },
            },
            activeUsers: { last5minutes: 3, last1hour: 10, last24hours: 20 },
          })
        : json({ error: `unexpected ${url}` }, 500),
    );
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/server", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      health: {
        version: "31.0.0",
        webserver: "nginx",
        phpVersion: "8.3.1",
        database: { type: "mysql", version: "10.11", sizeBytes: 1234 },
        cpuLoad: [0.1, 0.2, 0.3],
        memory: { totalBytes: 1000, freeBytes: 400 },
        swap: null,
        freeSpaceBytes: 99999,
        users: { total: 42, last5min: 3, last1h: 10, last24h: 20 },
        apps: { installed: 30, updatesAvailable: 2 },
      },
      basics: null,
    });
  });

  it("reports available=false when serverinfo denies non-admin accounts", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.includes("/apps/serverinfo/api/v1/info") ? json({}, 401) : json({}, 500),
    );
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/server", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, health: null, basics: null });
  });

  it("serves basics (capabilities + own quota) to non-admin accounts", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/apps/serverinfo/api/v1/info")) return json({}, 401);
      if (url.includes("/cloud/capabilities")) {
        return ocs({
          version: { string: "31.0.0" },
          capabilities: {
            theming: { name: "WIT Cloud", productname: "Nextcloud" },
            spreed: { version: "21.1.0" },
            user_status: { enabled: true },
            collectives: {},
          },
        });
      }
      if (url.endsWith("/cloud/user")) {
        return ocs({ quota: { used: 500, free: 500, total: 1000, relative: 50 } });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/server", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: false,
      health: null,
      basics: {
        product: "WIT Cloud",
        version: "31.0.0",
        quota: { usedBytes: 500, freeBytes: 500, totalBytes: 1000 },
        apps: { talk: "21.1.0", userStatus: true, collectives: true, tables: false },
      },
    });
  });

  it("merges Talk status with provisioning details and groups", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/apps/user_status/api/v1/statuses")) {
        return ocs([
          { userId: "frodo", status: "online", message: "on vacation", icon: "🌴" },
          { userId: "sam", status: "dnd" },
        ]);
      }
      if (url.includes("/cloud/users/details")) {
        return ocs({
          users: {
            frodo: {
              displayname: "Frodo B.",
              groups: ["shire", "admin"],
              lastLogin: 1700000000000,
            },
            sam: { displayname: "Sam", groups: ["shire"] },
            gollum: { displayname: "Gollum", groups: ["elsewhere"], lastLogin: 0 },
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/talk-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupsScope: "all",
      groups: ["admin", "elsewhere", "shire"],
      users: [
        {
          userId: "frodo",
          displayName: "Frodo B.",
          status: "online",
          message: "on vacation",
          icon: "🌴",
          groups: ["shire", "admin"],
          lastSeenAt: 1700000000000,
        },
        {
          userId: "gollum",
          displayName: "Gollum",
          status: "offline",
          message: null,
          icon: null,
          groups: ["elsewhere"],
          lastSeenAt: 0,
        },
        {
          userId: "sam",
          displayName: "Sam",
          status: "dnd",
          message: null,
          icon: null,
          groups: ["shire"],
          lastSeenAt: null,
        },
      ],
    });
  });

  it("degrades to groupsScope=none without admin rights, resolving names via autocomplete", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/apps/user_status/api/v1/statuses")) {
        return ocs([{ userId: "frodo", status: "online" }]);
      }
      if (url.includes("/apps/spreed/api/v4/core/autocomplete")) {
        return ocs([{ id: "frodo", label: "Frodo B.", source: "users" }]);
      }
      return json({}, 403);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/talk-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupsScope: "none",
      groups: [],
      users: [
        {
          userId: "frodo",
          displayName: "Frodo B.",
          status: "online",
          message: null,
          icon: null,
          groups: [],
          lastSeenAt: null,
        },
      ],
    });
  });

  it("resolves obfuscated user ids via DAV principals when autocomplete misses", async () => {
    const hash = "03d1595bc373e71671bc5d387c33c2414b9733bcb24aaa2de5cc8e23e258d4a3";
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/apps/user_status/api/v1/statuses")) {
        return ocs([{ userId: hash, status: "offline" }]);
      }
      if (init?.method === "PROPFIND" && url.includes("/principals/users/")) {
        return new Response(
          `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/principals/users/${hash}/</d:href>
    <d:propstat>
      <d:prop><d:displayname>Frodo B.</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
          { status: 207 },
        );
      }
      if (url.includes("/apps/spreed/api/v4/core/autocomplete")) {
        return ocs([]);
      }
      return json({}, 403);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/talk-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupsScope: "none",
      groups: [],
      users: [
        {
          userId: hash,
          displayName: "Frodo B.",
          status: "offline",
          message: null,
          icon: null,
          groups: [],
          lastSeenAt: null,
        },
      ],
    });
  });

  it("uses managed groups for group-admin accounts (groupsScope=partial)", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/apps/user_status/api/v1/statuses")) {
        return ocs([
          { userId: "frodo", status: "online" },
          { userId: "sam", status: "away" },
        ]);
      }
      if (url.includes("/cloud/users/details")) return json({}, 403);
      if (url.endsWith("/cloud/groups")) return ocs({ groups: ["shire"] });
      if (url.includes("/cloud/groups/shire/users")) {
        return ocs({ users: ["frodo", "sam"] });
      }
      if (init?.method === "PROPFIND" && url.includes("/principals/groups/shire")) {
        return new Response(
          `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/principals/groups/shire/</d:href>
    <d:propstat>
      <d:prop><d:displayname>The Shire</d:displayname></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`,
          { status: 207 },
        );
      }
      if (url.includes("/apps/spreed/api/v4/core/autocomplete")) {
        const q = new URL(url).searchParams.get("search");
        return ocs([{ id: q, label: `${q}-name`, source: "users" }]);
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/monitor/talk-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      groupsScope: "partial",
      groups: ["The Shire"],
      users: [
        {
          userId: "frodo",
          displayName: "frodo-name",
          status: "online",
          message: null,
          icon: null,
          groups: ["The Shire"],
          lastSeenAt: null,
        },
        {
          userId: "sam",
          displayName: "sam-name",
          status: "away",
          message: null,
          icon: null,
          groups: ["The Shire"],
          lastSeenAt: null,
        },
      ],
    });
  });
});

describe("wiki", () => {
  const P = "/remote.php/dav/files/frodo";
  const xmlResp = (entries: string) =>
    new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries}</d:multistatus>`, {
      status: 207,
      headers: { "content-type": "application/xml" },
    });
  const dir = (href: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const file = (href: string, etag: string) =>
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/><d:getetag>"${etag}"</d:getetag><d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

  const davFiles: Record<string, string> = {
    ".Collectives/Handbook/Intro.md": "# Intro\n\nHello world.",
  };
  const davFetch = () =>
    fakeFetch((url, init) => {
      if (init?.method === "PROPFIND") {
        if (url.endsWith(`${P}/.Collectives`)) {
          return xmlResp(dir(`${P}/.Collectives/`) + dir(`${P}/.Collectives/Handbook/`));
        }
        if (url.endsWith(`${P}/.Collectives/Handbook`)) {
          return xmlResp(
            dir(`${P}/.Collectives/Handbook/`) +
              Object.keys(davFiles)
                .filter((p) => p.startsWith(".Collectives/Handbook/"))
                .map((p) => file(`${P}/${p}`, `e-${p}`))
                .join(""),
          );
        }
        return new Response("not found", { status: 404 });
      }
      const match = Object.entries(davFiles).find(([p]) => url.endsWith(`${P}/${p}`));
      if (match) return new Response(match[1]);
      return json({ error: `unexpected ${init?.method} ${url}` }, 500);
    });

  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/wiki/tree", headers: auth })).statusCode,
    ).toBe(424);
  });

  it("syncs, serves tree/page/search, and prunes deleted files", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: davFetch() });
    connect(store, secrets);

    const sync = await app.inject({ method: "POST", url: "/api/wiki/sync", headers: auth });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().pages).toBe(1);

    const tree = await app.inject({ method: "GET", url: "/api/wiki/tree", headers: auth });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().pages).toEqual([
      {
        path: "Handbook/Intro.md",
        title: "Intro",
        collective: "Handbook",
        mtime: "Wed, 01 Jan 2025 00:00:00 GMT",
      },
    ]);

    const page = await app.inject({
      method: "GET",
      url: "/api/wiki/page?path=Handbook%2FIntro.md",
      headers: auth,
    });
    expect(page.statusCode).toBe(200);
    expect(page.json().content).toBe("# Intro\n\nHello world.");

    const search = await app.inject({
      method: "GET",
      url: "/api/wiki/search?q=world",
      headers: auth,
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results).toHaveLength(1);
    expect(search.json().results[0].snippet).toContain("Hello world.");

    // File deleted upstream → pruned on next sync.
    delete davFiles[".Collectives/Handbook/Intro.md"];
    await app.inject({ method: "POST", url: "/api/wiki/sync", headers: auth });
    const empty = await app.inject({
      method: "GET",
      url: "/api/wiki/page?path=Handbook%2FIntro.md",
      headers: auth,
    });
    expect(empty.statusCode).toBe(404);
  });

  it("discovers the per-user collectives folder via the user_folder setting", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url.includes("/collectives/api/v1.0/settings/user/user_folder")) {
        return json({
          ocs: {
            meta: { status: "ok", statuscode: 200 },
            data: { user_folder: "Docs/SharedNotes" },
          },
        });
      }
      if (init?.method === "PROPFIND") {
        if (url.endsWith(`${P}/Docs/SharedNotes`)) {
          return xmlResp(dir(`${P}/Docs/SharedNotes/`) + dir(`${P}/Docs/SharedNotes/Handbook/`));
        }
        if (url.endsWith(`${P}/Docs/SharedNotes/Handbook`)) {
          return xmlResp(
            dir(`${P}/Docs/SharedNotes/Handbook/`) +
              file(`${P}/Docs/SharedNotes/Handbook/Guide.md`, "e-guide"),
          );
        }
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith(`${P}/Docs/SharedNotes/Handbook/Guide.md`)) {
        return new Response("# Guide");
      }
      return json({ error: `unexpected ${init?.method} ${url}` }, 500);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const tree = await app.inject({ method: "GET", url: "/api/wiki/tree", headers: auth });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().pages).toEqual([
      {
        path: "Handbook/Guide.md",
        title: "Guide",
        collective: "Handbook",
        mtime: "Wed, 01 Jan 2025 00:00:00 GMT",
      },
    ]);
  });

  it("reports an empty mirror when Collectives is not installed", async () => {
    const fetchImpl = fakeFetch(() => new Response("not found", { status: 404 }));
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/wiki/tree", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().pages).toEqual([]);
  });

  it("mirrors a local directory via MODULE_WIKI_SOURCE_DIR (basename = collective)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "einring-wiki-"));
    await mkdir(join(dir, "Sub"), { recursive: true });
    await mkdir(join(dir, ".obsidian"), { recursive: true });
    await writeFile(join(dir, "Readme.md"), "# WIT\n\nRoot page.");
    await writeFile(join(dir, "Sub", "Page.md"), "# Sub\n\nNested page.");
    await writeFile(join(dir, ".obsidian", "app.json"), "{}");
    try {
      const { app, auth, store, secrets } = await testApp({
        config: loadConfig({ ...testEnv(), MODULE_WIKI_SOURCE_DIR: dir }),
      });
      connect(store, secrets);
      const tree = await app.inject({ method: "GET", url: "/api/wiki/tree", headers: auth });
      expect(tree.statusCode).toBe(200);
      const collective = basename(dir);
      expect(
        tree
          .json()
          .pages.map((p: { path: string }) => p.path)
          .sort(),
      ).toEqual([`${collective}/Readme.md`, `${collective}/Sub/Page.md`]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("csv-manager", () => {
  const CSV = 'Name;Amount;Note\nRing;3;"one ring"\nBread;10;plain\n';

  const importFile = async (
    app: Awaited<ReturnType<typeof testApp>>["app"],
    auth: { authorization: string },
  ) =>
    await app.inject({
      method: "POST",
      url: "/api/csv-manager/files",
      headers: auth,
      payload: { name: "list.csv", csv: CSV },
    });

  it("requires auth on all endpoints", async () => {
    const { app } = await testApp();
    for (const [method, url] of [
      ["GET", "/api/csv-manager/files"],
      ["POST", "/api/csv-manager/files"],
      ["GET", "/api/csv-manager/files/1"],
      ["DELETE", "/api/csv-manager/files/1"],
      ["POST", "/api/csv-manager/files/1/rows"],
      ["PATCH", "/api/csv-manager/files/1/rows/1"],
      ["DELETE", "/api/csv-manager/files/1/rows/1"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(401);
    }
  });

  it("imports a semicolon CSV, lists it and serves padded rows", async () => {
    const { app, auth } = await testApp();
    const res = await importFile(app, auth);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      name: "list.csv",
      headers: ["Name", "Amount", "Note"],
      rowCount: 2,
    });
    const id = res.json().id;

    const list = await app.inject({ method: "GET", url: "/api/csv-manager/files", headers: auth });
    expect(list.json().files).toEqual([
      expect.objectContaining({ id, name: "list.csv", rowCount: 2 }),
    ]);

    const file = await app.inject({
      method: "GET",
      url: `/api/csv-manager/files/${id}`,
      headers: auth,
    });
    expect(file.statusCode).toBe(200);
    expect(file.json().rows).toEqual([
      { id: expect.any(Number), cells: ["Ring", "3", "one ring"], done: false },
      { id: expect.any(Number), cells: ["Bread", "10", "plain"], done: false },
    ]);
  });

  it("parses quoted commas, escaped quotes and embedded newlines", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/csv-manager/files",
      headers: auth,
      payload: { name: "q.csv", csv: 'A,B\n"x,y","he said ""hi""\nline2"' },
    });
    expect(res.statusCode).toBe(201);
    const file = await app.inject({
      method: "GET",
      url: `/api/csv-manager/files/${res.json().id}`,
      headers: auth,
    });
    expect(file.json().rows[0].cells).toEqual(["x,y", 'he said "hi"\nline2']);
  });

  it("edits cells and the done flag, adds and deletes rows", async () => {
    const { app, auth } = await testApp();
    const fileId = (await importFile(app, auth)).json().id;
    const file = await app.inject({
      method: "GET",
      url: `/api/csv-manager/files/${fileId}`,
      headers: auth,
    });
    const rowId = file.json().rows[0].id;

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/csv-manager/files/${fileId}/rows/${rowId}`,
      headers: auth,
      payload: { cells: ["Ring", "4", "kept"], done: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ id: rowId, cells: ["Ring", "4", "kept"], done: true });

    const added = await app.inject({
      method: "POST",
      url: `/api/csv-manager/files/${fileId}/rows`,
      headers: auth,
      payload: { cells: ["Lembas"] },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({
      id: expect.any(Number),
      cells: ["Lembas", "", ""],
      done: false,
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/csv-manager/files/${fileId}/rows/${rowId}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: `/api/csv-manager/files/${fileId}`,
      headers: auth,
    });
    expect(after.json().rows.map((r: { id: number }) => r.id)).not.toContain(rowId);
    expect(after.json().rows).toHaveLength(2);
  });

  it("deletes a file with its rows", async () => {
    const { app, auth } = await testApp();
    const fileId = (await importFile(app, auth)).json().id;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/csv-manager/files/${fileId}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(204);
    const res = await app.inject({
      method: "GET",
      url: `/api/csv-manager/files/${fileId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/api/csv-manager/files", headers: auth });
    expect(list.json().files).toHaveLength(0);
  });

  it("rejects bad imports and updates", async () => {
    const { app, auth } = await testApp();
    const post = (payload: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/csv-manager/files",
        headers: auth,
        payload: payload as Record<string, unknown>,
      });
    expect((await post({ name: "x.csv" })).statusCode).toBe(400); // no csv
    expect((await post({ name: "", csv: "a,b" })).statusCode).toBe(400); // no name
    expect((await post({ name: "x.csv", csv: "\n\n" })).statusCode).toBe(400); // no header
    expect((await post({ name: "x.csv", csv: 'a,b\n"unclosed' })).statusCode).toBe(400); // quotes
    expect(
      (await app.inject({ method: "GET", url: "/api/csv-manager/files/999", headers: auth }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/csv-manager/files/999/rows/1",
          headers: auth,
          payload: { done: true },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("scopes files and rows to the owning sub", async () => {
    const { app, auth } = await testApp({
      verifyToken: async (token) => (token === "other-token" ? { sub: "other-user" } : TEST_USER),
    });
    const fileId = (await importFile(app, auth)).json().id;
    const other = { authorization: "Bearer other-token" };
    for (const [method, url] of [
      ["GET", `/api/csv-manager/files/${fileId}`],
      ["DELETE", `/api/csv-manager/files/${fileId}`],
      ["POST", `/api/csv-manager/files/${fileId}/rows`],
      ["PATCH", `/api/csv-manager/files/${fileId}/rows/1`],
      ["DELETE", `/api/csv-manager/files/${fileId}/rows/1`],
    ] as const) {
      const res = await app.inject({ method, url, headers: other });
      expect(res.statusCode).toBe(404);
    }
    const list = await app.inject({ method: "GET", url: "/api/csv-manager/files", headers: other });
    expect(list.json().files).toHaveLength(0);
  });

  it("refuses files beyond MODULE_CSV_MANAGER_MAX_ROWS", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_CSV_MANAGER_MAX_ROWS: "1" }),
    });
    const res = await importFile(app, auth);
    expect(res.statusCode).toBe(413);
  });
});

describe("wiki llm", () => {
  const llmEnv = (extra: Record<string, string> = {}) => ({
    ...testEnv(),
    LLM_URL: "https://llm.test/v1",
    LLM_API_KEY: "sk-secret",
    LLM_CHAT_MODEL: "chat-m",
    LLM_EMBED_MODEL: "embed-m",
    ...extra,
  });

  const seedPage = (store: Store, sub: string, path: string, title: string, content: string) =>
    store.upsertWikiPage({
      sub,
      path,
      title,
      content,
      etag: `e-${path}`,
      mtime: null,
      syncedAt: "2025-01-01T00:00:00Z",
    });

  /** Vectors rank by lexical overlap with "ring": [1,0,0] ring-ish, else [0,1,0]. */
  const embedFor = (text: string) => (text.toLowerCase().includes("ring") ? [1, 0, 0] : [0, 1, 0]);

  const llmFake = (opts: { onChat?: (body: unknown) => void; failEmbeds?: boolean } = {}) =>
    fakeFetch(async (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth).toBe("Bearer sk-secret");
      const body = JSON.parse(String(init?.body)) as { model?: string; input?: string[] };
      if (url === "https://llm.test/v1/embeddings") {
        if (opts.failEmbeds) return json({ error: "boom" }, 500);
        expect(body.model).toBe("embed-m");
        const inputs = body.input ?? [];
        return json({ data: inputs.map((t, i) => ({ index: i, embedding: embedFor(t) })) });
      }
      if (url === "https://llm.test/v1/chat/completions") {
        expect(body.model).toBe("chat-m");
        opts.onChat?.(body);
        return json({ choices: [{ message: { content: "It lies in Mordor." } }] });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });

  it("answers 424 and reports configured=false when LLM is unset", async () => {
    const { app, auth } = await testApp();
    expect(
      (await app.inject({ method: "POST", url: "/api/wiki/llm/index", headers: auth })).statusCode,
    ).toBe(424);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/wiki/ask",
          headers: auth,
          payload: { question: "hi" },
        })
      ).statusCode,
    ).toBe(424);
    const status = await app.inject({
      method: "GET",
      url: "/api/wiki/llm/status",
      headers: auth,
    });
    expect(status.json()).toMatchObject({ configured: false, chunks: 0 });
  });

  it("indexes pages, answers with top-k chunks and cites sources", async () => {
    let chatBody: { messages?: { role: string; content: string }[] } | undefined;
    const { app, auth, store } = await testApp({
      config: loadConfig(llmEnv({ LLM_TOP_K: "2" })),
      fetchImpl: llmFake({ onChat: (b) => (chatBody = b as typeof chatBody) }),
    });
    seedPage(store, TEST_USER.sub, "Handbook/Ring.md", "Ring", "# Ring\n\nHidden in Mordor.");
    seedPage(store, TEST_USER.sub, "Handbook/Bread.md", "Bread", "# Bread\n\nLembas is filling.");
    // Another user's indexed chunk that would rank first must not leak into the prompt.
    store.replaceWikiChunks("other-user", "Secret/Ring.md", "e-other", [
      { text: "ring secret", embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer) },
    ]);

    const index = await app.inject({ method: "POST", url: "/api/wiki/llm/index", headers: auth });
    expect(index.statusCode).toBe(200);
    expect(index.json()).toMatchObject({ pages: 2, embeddedPages: 2 });
    // Indexing only touched the caller's chunks — the other user's row is untouched.
    expect(store.listWikiChunks("other-user")).toHaveLength(1);
    // Indexing only affects the caller's chunks.
    const status = await app.inject({
      method: "GET",
      url: "/api/wiki/llm/status",
      headers: auth,
    });
    expect(status.json()).toMatchObject({ configured: true, indexedPages: 2, chunks: 2 });

    const res = await app.inject({
      method: "POST",
      url: "/api/wiki/ask",
      headers: auth,
      payload: { question: "where is the ring?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answer: "It lies in Mordor.",
      sources: [
        { path: "Handbook/Ring.md", title: "Ring" },
        { path: "Handbook/Bread.md", title: "Bread" },
      ],
    });
    expect(JSON.stringify(res.json())).not.toContain("sk-secret");
    // TOP_K=2: both own chunks enter the prompt; the other user's chunk must not.
    const prompt = chatBody?.messages?.[1]?.content ?? "";
    expect(prompt).toContain("### Handbook/Ring.md");
    expect(prompt).toContain("### Handbook/Bread.md");
    expect(prompt).not.toContain("Secret/Ring.md");
    // Ranking: the ring-matching chunk precedes the bread chunk in the context.
    expect(prompt.indexOf("Ring.md")).toBeLessThan(prompt.indexOf("Bread.md"));

    // A second index run reuses etags — nothing re-embedded.
    const again = await app.inject({
      method: "POST",
      url: "/api/wiki/llm/index",
      headers: auth,
    });
    expect(again.json()).toMatchObject({ pages: 2, embeddedPages: 0 });
  });

  it("answers 409 on an empty index and 400 on a bad question", async () => {
    const { app, auth } = await testApp({ config: loadConfig(llmEnv()) });
    const ask = (question: unknown) =>
      app.inject({ method: "POST", url: "/api/wiki/ask", headers: auth, payload: { question } });
    expect((await ask("anything")).statusCode).toBe(409); // not indexed
    expect((await ask("")).statusCode).toBe(400);
    expect((await ask("   ")).statusCode).toBe(400);
    expect((await ask("x".repeat(2001))).statusCode).toBe(400);
  });

  it("surfaces provider failures as 502", async () => {
    const { app, auth, store } = await testApp({
      config: loadConfig(llmEnv()),
      fetchImpl: llmFake({ failEmbeds: true }),
    });
    store.replaceWikiChunks(TEST_USER.sub, "Handbook/Ring.md", "e1", [
      { text: "ring text", embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer) },
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/wiki/ask",
      headers: auth,
      payload: { question: "where?" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("llm");
  });
});

describe("einchat", () => {
  const chatEnv = (extra: Record<string, string> = {}) => ({
    ...testEnv(),
    LLM_URL: "https://llm.test/v1",
    LLM_CHAT_MODEL: "chat-m",
    LLM_EMBED_MODEL: "embed-m",
    ...extra,
  });

  /** Wraps a sequence of chat-completion responses; records each request body. */
  const chatFake = (
    turns: object[],
    calls: { body: { messages?: { role: string }[] } }[] = [],
    extra?: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>,
  ) =>
    fakeFetch(async (url, init) => {
      const viaExtra = await extra?.(url, init);
      if (viaExtra) return viaExtra;
      if (url === "https://llm.test/v1/chat/completions") {
        const body = JSON.parse(String(init?.body)) as { messages?: { role: string }[] };
        calls.push({ body });
        return json(turns[Math.min(calls.length - 1, turns.length - 1)]);
      }
      return json({ error: `unexpected ${url}` }, 500);
    });

  const toolCall = (name: string, args: object, id = "call-1") => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  });
  const reply = (content: string) => ({ choices: [{ message: { role: "assistant", content } }] });

  const post = (app: FastifyInstance, auth: Record<string, string>, payload: object) =>
    app.inject({ method: "POST", url: "/api/einchat/message", headers: auth, payload });

  it("reports configured=false and 424s when the LLM is unset", async () => {
    const { app, auth } = await testApp();
    const status = await app.inject({ method: "GET", url: "/api/einchat/status", headers: auth });
    expect(status.json().configured).toBe(false);
    expect(
      (await post(app, auth, { messages: [{ role: "user", content: "hi" }] })).statusCode,
    ).toBe(424);
  });

  it("lists enabled provider tools in status", async () => {
    const { app, auth } = await testApp({ config: loadConfig(chatEnv()) });
    const status = await app.inject({ method: "GET", url: "/api/einchat/status", headers: auth });
    expect(status.json()).toEqual({
      configured: true,
      tools: [
        "einhub_notifications",
        "wiki_search",
        "yamtrack_search_media",
        "yamtrack_list_media",
        "audiobookshelf_search",
        "audiobookshelf_in_progress",
        "navidrome_search",
        "navidrome_albums",
        "einmusic_library",
        "trek_list_trips",
        "trek_trip_details",
        "trek_bucket_list",
        "email_recent",
        "email_read",
        "gotify_recent_messages",
        "gotify_applications",
        "gitlab_todos",
        "github_notifications",
        "authentik_status",
        "matrix_rooms",
        "eindav_contacts",
        "recipes_search",
        "school_today",
      ],
    });
  });

  it("returns the reply directly when the model makes no tool calls", async () => {
    const calls: { body: { messages?: { role: string }[] } }[] = [];
    const { app, auth } = await testApp({
      config: loadConfig(chatEnv()),
      fetchImpl: chatFake([reply("Hello there.")], calls),
    });
    const res = await post(app, auth, { messages: [{ role: "user", content: "hi" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reply: "Hello there." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.messages?.[0]?.role).toBe("system");
  });

  it("rejects malformed histories", async () => {
    const { app, auth } = await testApp({ config: loadConfig(chatEnv()) });
    expect((await post(app, auth, {})).statusCode).toBe(400);
    expect((await post(app, auth, { messages: [] })).statusCode).toBe(400);
    expect(
      (await post(app, auth, { messages: [{ role: "system", content: "x" }] })).statusCode,
    ).toBe(400);
  });

  it("runs the tool loop: call → result message → final answer", async () => {
    const calls: {
      body: { messages?: { role: string; content?: string; tool_call_id?: string }[] };
    }[] = [];
    const yt = (url: string) => {
      if (url === "https://yt.test/api/v1/media/movie/?limit=200&offset=0") {
        return json([{ title: "The Ring", media_id: 1, media_type: "movie", status: 3 }]);
      }
      if (url.startsWith("https://yt.test/")) return json({ error: `unexpected ${url}` }, 404);
      return null; // not ours — fall through to the LLM fake
    };
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(chatEnv()),
      fetchImpl: chatFake(
        [toolCall("yamtrack_search_media", { query: "ring" }), reply("Yes — watched.")],
        calls,
        yt,
      ),
    });
    // Connect the user's yamtrack account directly in the store.
    store.saveServiceCredential({
      sub: TEST_USER.sub,
      service: "yamtrack",
      url: "https://yt.test",
      secretSealed: secrets.seal("yt-key"),
    });
    const res = await post(app, auth, {
      messages: [{ role: "user", content: "have I watched The Ring?" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("Yes — watched.");
    expect(calls).toHaveLength(2);
    const toolMsg = calls[1]?.body.messages?.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call-1");
    expect(toolMsg?.content).toContain("The Ring");
    expect(toolMsg?.content).toContain('"watched":true');
    // The stored key never reaches the model.
    expect(toolMsg?.content).not.toContain("yt-key");
  });

  it("tells the model the service is not connected when the user has no credential", async () => {
    const calls: { body: { messages?: { role: string; content?: string }[] } }[] = [];
    const { app, auth } = await testApp({
      config: loadConfig(chatEnv()),
      fetchImpl: chatFake(
        [toolCall("yamtrack_search_media", { query: "ring" }), reply("Connect Yamtrack first.")],
        calls,
      ),
    });
    const res = await post(app, auth, {
      messages: [{ role: "user", content: "have I watched The Ring?" }],
    });
    expect(res.json().reply).toBe("Connect Yamtrack first.");
    const toolMsg = calls[1]?.body.messages?.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("not_connected");
  });

  it("caps the loop at 5 tool rounds, then forces a final answer", async () => {
    const calls: { body: unknown }[] = [];
    const { app, auth } = await testApp({
      config: loadConfig(chatEnv()),
      fetchImpl: chatFake(
        [
          toolCall("nope_tool", {}),
          toolCall("nope_tool", {}),
          toolCall("nope_tool", {}),
          toolCall("nope_tool", {}),
          toolCall("nope_tool", {}),
          reply("summary"),
        ],
        calls as never,
      ),
    });
    const res = await post(app, auth, { messages: [{ role: "user", content: "go" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("summary");
    expect(calls).toHaveLength(6); // 5 tool rounds + 1 forced final
  });

  it("lists tools per module with enabled flags; PUT persists the selection", async () => {
    const { app, auth, store } = await testApp({ config: loadConfig(chatEnv()) });
    const all = await app.inject({ method: "GET", url: "/api/einchat/tools", headers: auth });
    expect(
      all
        .json()
        .tools.filter((t: { module: string }) => t.module === "wiki" || t.module === "yamtrack"),
    ).toEqual([
      { name: "wiki_search", module: "wiki", enabled: true },
      { name: "yamtrack_search_media", module: "yamtrack", enabled: true },
      { name: "yamtrack_list_media", module: "yamtrack", enabled: true },
    ]);
    expect(all.json().tools.length).toBe(23);
    const put = await app.inject({
      method: "PUT",
      url: "/api/einchat/tools",
      headers: auth,
      payload: { disabled: ["yamtrack_search_media", "yamtrack_list_media"] },
    });
    expect(put.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/einchat/tools", headers: auth });
    expect(after.json().tools.find((t: { name: string }) => t.name === "wiki_search").enabled).toBe(
      true,
    );
    expect(
      after.json().tools.filter((t: { module: string }) => t.module === "yamtrack"),
    ).toHaveLength(2);
    expect(
      after
        .json()
        .tools.every((t: { enabled: boolean; module: string }) =>
          t.module === "yamtrack" ? !t.enabled : t.enabled,
        ),
    ).toBe(true);
    // Per-user: another sub keeps the default (all enabled).
    expect(store.getModuleSettings("other-user", "einchat")).toBeUndefined();
    // Bad payloads
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/einchat/tools",
          headers: auth,
          payload: { disabled: "x" },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("disabled tools are not offered to the model (and status reflects it)", async () => {
    const calls: { body: { tools?: { function: { name: string } }[] } }[] = [];
    const { app, auth } = await testApp({
      config: loadConfig(chatEnv()),
      fetchImpl: chatFake([reply("ok")], calls as never),
    });
    const all = await app.inject({ method: "GET", url: "/api/einchat/tools", headers: auth });
    await app.inject({
      method: "PUT",
      url: "/api/einchat/tools",
      headers: auth,
      payload: { disabled: all.json().tools.map((t: { name: string }) => t.name) },
    });
    const status = await app.inject({ method: "GET", url: "/api/einchat/status", headers: auth });
    expect(status.json().tools).toEqual([]);
    const res = await post(app, auth, { messages: [{ role: "user", content: "hi" }] });
    expect(res.statusCode).toBe(200);
    // No tools offered — the field is omitted entirely.
    expect(calls[0]?.body.tools).toBeUndefined();
  });
});

describe("yamtrack", () => {
  const ytEnv = { ...testEnv(), MODULE_YAMTRACK_URL: "https://yt.test" };

  const ytFake = (behaviour?: (url: string, init?: RequestInit) => Response | null) =>
    fakeFetch(async (url, init) => {
      const custom = behaviour?.(url, init);
      if (custom) return custom;
      if (url.startsWith("https://yt.test/api/v1/media/")) return json([]);
      return json({ error: `unexpected ${url}` }, 404);
    });

  it("connects, verifies the key, reports status and disconnects per user", async () => {
    let sawKey: string | undefined;
    const { app, auth, store } = await testApp({
      config: loadConfig(ytEnv),
      fetchImpl: ytFake((_url, init) => {
        sawKey = (init?.headers as Record<string, string> | undefined)?.["X-API-Key"];
        return null;
      }),
    });
    const status = await app.inject({ method: "GET", url: "/api/yamtrack/status", headers: auth });
    expect(status.json()).toEqual({ connected: false, url: "https://yt.test" });

    const conn = await app.inject({
      method: "POST",
      url: "/api/yamtrack/credentials",
      headers: auth,
      payload: { apiKey: "yt-secret" },
    });
    expect(conn.statusCode).toBe(200);
    expect(conn.json()).toEqual({ connected: true, url: "https://yt.test" });
    expect(sawKey).toBe("yt-secret");
    // Stored sealed — never in clear, never in a response.
    const row = store.getServiceCredential(TEST_USER.sub, "yamtrack");
    expect(row?.secretSealed).not.toContain("yt-secret");
    expect(JSON.stringify(conn.json())).not.toContain("yt-secret");

    const after = await app.inject({ method: "GET", url: "/api/yamtrack/status", headers: auth });
    expect(after.json()).toEqual({ connected: true, url: "https://yt.test" });

    const del = await app.inject({
      method: "DELETE",
      url: "/api/yamtrack/credentials",
      headers: auth,
    });
    expect(del.json()).toEqual({ connected: false });
    expect(store.getServiceCredential(TEST_USER.sub, "yamtrack")).toBeUndefined();
  });

  it("rejects a bad api key and a missing url", async () => {
    const { app, auth } = await testApp({
      config: loadConfig(ytEnv),
      fetchImpl: fakeFetch(() => json({ detail: "no" }, 401)),
    });
    const bad = await app.inject({
      method: "POST",
      url: "/api/yamtrack/credentials",
      headers: auth,
      payload: { apiKey: "nope" },
    });
    expect(bad.statusCode).toBe(401);
    const noUrl = await app.inject({
      method: "POST",
      url: "/api/yamtrack/credentials",
      headers: auth,
      payload: { apiKey: "x" },
    });
    expect(noUrl.statusCode).toBe(401); // still fails at yamtrack — url came from env
    // Without MODULE_YAMTRACK_URL and no body url → 400.
    const { app: bare, auth: bareAuth } = await testApp();
    const missing = await bare.inject({
      method: "POST",
      url: "/api/yamtrack/credentials",
      headers: bareAuth,
      payload: { apiKey: "x" },
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe("connectors (audiobookshelf, navidrome, trek)", () => {
  const llm = {
    LLM_URL: "https://llm.test/v1",
    LLM_CHAT_MODEL: "chat-m",
    LLM_EMBED_MODEL: "embed-m",
  };

  it("audiobookshelf: verifies via /api/me, searches libraries with progress", async () => {
    let sawAuth: string | undefined;
    const fetches: string[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      fetches.push(url);
      sawAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url === "https://abs.test/api/libraries") {
        return json({ libraries: [{ id: "l1", name: "Books" }] });
      }
      if (url === "https://abs.test/api/libraries/l1/search?q=ring") {
        return json({
          book: [
            {
              libraryItem: {
                id: "i1",
                media: { metadata: { title: "Ring Audio", authorName: "Tolkien" } },
              },
            },
          ],
        });
      }
      if (url === "https://abs.test/api/me") {
        return json({ mediaProgress: [{ libraryItemId: "i1", progress: 0.5, isFinished: false }] });
      }
      if (url === "https://llm.test/v1/chat/completions") {
        const body = JSON.parse(String(init?.body)) as { messages: unknown[] };
        return json(
          (body.messages ?? []).some((m) => (m as { role: string }).role === "tool")
            ? { choices: [{ message: { role: "assistant", content: "half done" } }] }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "c1",
                          type: "function",
                          function: {
                            name: "audiobookshelf_search",
                            arguments: JSON.stringify({ query: "ring" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
        );
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), ...llm }),
      fetchImpl,
    });
    // Bad key → 401.
    const { app: badApp, auth: badAuth } = await testApp({
      config: loadConfig(testEnv()),
      fetchImpl: fakeFetch(() => json({}, 401)),
    });
    expect(
      (
        await badApp.inject({
          method: "POST",
          url: "/api/audiobookshelf/credentials",
          headers: badAuth,
          payload: { apiKey: "x", url: "https://abs.test" },
        })
      ).statusCode,
    ).toBe(401);

    const conn = await app.inject({
      method: "POST",
      url: "/api/audiobookshelf/credentials",
      headers: auth,
      payload: { apiKey: "abs-token", url: "https://abs.test" },
    });
    expect(conn.statusCode).toBe(200);
    expect(sawAuth).toBe("Bearer abs-token");

    // Tool call: the LLM calls audiobookshelf_search, gets progress-annotated hits.
    const res = await app.inject({
      method: "POST",
      url: "/api/einchat/message",
      headers: auth,
      payload: { messages: [{ role: "user", content: "did I start Ring Audio?" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toBe("half done");
    expect(fetches).toContain("https://abs.test/api/libraries/l1/search?q=ring");
  });

  it("navidrome: subsonic token auth, ping verify, search3 tool", async () => {
    let pingQuery = "";
    const fetchImpl = fakeFetch(async (url) => {
      if (url.startsWith("https://nd.test/rest/ping.view?")) {
        pingQuery = url;
        return json({ "subsonic-response": { status: "ok", version: "1.16.1" } });
      }
      if (url.startsWith("https://nd.test/rest/search3.view?")) {
        return json({
          "subsonic-response": {
            status: "ok",
            searchResult3: {
              artist: [{ name: "Rammstein" }],
              album: [{ name: "Mutter", artist: "Rammstein", year: 2001 }],
              song: [],
            },
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth } = await testApp({ config: loadConfig(testEnv()), fetchImpl });
    const conn = await app.inject({
      method: "POST",
      url: "/api/navidrome/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring-bearer", url: "https://nd.test" },
    });
    expect(conn.statusCode).toBe(200);
    expect(pingQuery).toContain("u=frodo");
    expect(pingQuery).toMatch(/t=[0-9a-f]{32}/); // md5 token, never the password
    expect(pingQuery).not.toContain("ring-bearer");
  });

  it("trek: bearer key verify, list trips + details tools", async () => {
    let sawAuth: string | undefined;
    const fetchImpl = fakeFetch(async (url, init) => {
      sawAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (url === "https://trek.test/api/v1/trips") {
        return json({
          trips: [{ id: 12, title: "Tuscany", start_date: "2026-06-14", archived: false }],
        });
      }
      if (url === "https://trek.test/api/v1/trips/12") {
        return json({
          trip: {
            id: 12,
            title: "Tuscany",
            days: [{ date: "2026-06-14", title: "Arrival", places: [{ name: "Siena" }] }],
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store } = await testApp({ config: loadConfig(testEnv()), fetchImpl });
    const conn = await app.inject({
      method: "POST",
      url: "/api/trek/credentials",
      headers: auth,
      payload: { apiKey: "trek_abc", url: "https://trek.test" },
    });
    expect(conn.statusCode).toBe(200);
    expect(sawAuth).toBe("Bearer trek_abc");
    expect(store.getServiceCredential(TEST_USER.sub, "trek")?.url).toBe("https://trek.test");
    const del = await app.inject({
      method: "DELETE",
      url: "/api/trek/credentials",
      headers: auth,
    });
    expect(del.json()).toEqual({ connected: false });
  });
});

describe("email", () => {
  const RFC822 = [
    "From: Galadriel <galadriel@lorien.test>",
    "To: frodo@shire.test",
    "Subject: Ring status",
    "Date: Tue, 16 Oct 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "It is still on your finger.",
  ].join("\r\n");

  /** Fake IMAP client: `exists` envelopes + one readable source (uid 42). */
  function fakeImap(opts: { exists?: number; authFail?: boolean } = {}) {
    const envelopes = Array.from({ length: opts.exists ?? 7 }, (_, i) => ({
      uid: 36 + i,
      envelope: {
        subject: `Mail ${i + 1}`,
        date: new Date(`2026-10-${10 + i}T08:00:00Z`),
        from: [{ name: `Sender ${i + 1}`, address: `s${i + 1}@test` }],
      },
    }));
    const calls: { host?: string; port?: number; user?: string } = {};
    const deleted: number[] = [];
    const open = async (c: { host: string; port: number; user: string }) => {
      Object.assign(calls, c);
      if (opts.authFail) {
        const err = new Error("AUTHENTICATIONFAILED") as Error & { authenticationFailed: boolean };
        err.authenticationFailed = true;
        throw err;
      }
      return {
        mailbox: { exists: envelopes.length },
        connect: async () => {},
        logout: async () => {},
        getMailboxLock: async () => ({ release: () => {} }),
        async *fetch(range: string) {
          // honor "<start>:*" seq ranges (1-based), like a real server
          const start = Number(range.split(":")[0]) || 1;
          for (const m of envelopes.slice(start - 1)) yield m;
        },
        fetchOne: async (_seq: unknown, query?: { source?: boolean }) => {
          const uid = Number(_seq);
          if (uid === 42) {
            return { uid, source: query?.source ? Buffer.from(RFC822) : undefined };
          }
          return false;
        },
        messageDelete: async (range: number | string) => {
          deleted.push(Number(range));
          return true;
        },
      };
    };
    return { open, calls, deleted };
  }

  it("connects with a bare host, verifies via IMAP login, lists last 5", async () => {
    const imap = fakeImap();
    const { app, auth, store } = await testApp({ imapOpen: imap.open });
    const conn = await app.inject({
      method: "POST",
      url: "/api/email/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring", url: "imap.test" },
    });
    expect(conn.statusCode).toBe(200);
    expect(conn.json()).toEqual({ connected: true, url: "imaps://imap.test" });
    expect(imap.calls).toMatchObject({ host: "imap.test", port: 993, user: "frodo" });
    expect(store.getServiceCredential(TEST_USER.sub, "email")?.secretSealed).not.toContain("ring");

    const list = await app.inject({ method: "GET", url: "/api/email/list", headers: auth });
    expect(list.statusCode).toBe(200);
    const emails = list.json().emails as { uid: number; subject: string }[];
    expect(emails).toHaveLength(5); // 7 exist → newest 5
    expect(emails[0]?.uid).toBe(42); // reversed: newest first
    expect(emails[0]?.subject).toBe("Mail 7");
  });

  it("reads a message body by uid, 404s unknown, 424s unconnected", async () => {
    const imap = fakeImap();
    const { app, auth } = await testApp({ imapOpen: imap.open });
    await app.inject({
      method: "POST",
      url: "/api/email/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring", url: "imaps://imap.test:9993" },
    });
    expect(imap.calls.port).toBe(9993);

    const msg = await app.inject({ method: "GET", url: "/api/email/message/42", headers: auth });
    expect(msg.statusCode).toBe(200);
    expect(msg.json()).toMatchObject({
      subject: "Ring status",
      from: { address: "galadriel@lorien.test" },
      text: expect.stringContaining("still on your finger"),
    });

    expect(
      (await app.inject({ method: "GET", url: "/api/email/message/99", headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "GET", url: "/api/email/message/x", headers: auth })).statusCode,
    ).toBe(400);

    const del = await app.inject({ method: "DELETE", url: "/api/email/message/42", headers: auth });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: true });
    expect(imap.deleted).toEqual([42]);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/email/message/99", headers: auth }))
        .statusCode,
    ).toBe(404);

    const { app: bare, auth: bareAuth } = await testApp({ imapOpen: imap.open });
    expect(
      (await bare.inject({ method: "GET", url: "/api/email/list", headers: bareAuth })).statusCode,
    ).toBe(424);
  });

  it("maps an IMAP auth failure to 401 and never stores the secret", async () => {
    const imap = fakeImap({ authFail: true });
    const { app, auth, store } = await testApp({ imapOpen: imap.open });
    const conn = await app.inject({
      method: "POST",
      url: "/api/email/credentials",
      headers: auth,
      payload: { username: "frodo", password: "wrong", url: "imap.test" },
    });
    expect(conn.statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "email")).toBeUndefined();
  });
});

describe("gotify", () => {
  const URL_ = "https://push.test";
  const CLIENT = { id: 7, token: "Ctok-abc", name: "einring" };
  const MSG = {
    id: 11,
    appid: 2,
    title: "Backup done",
    message: "**ok** in 3s",
    date: "2026-10-16T10:00:00Z",
    priority: 5,
    extras: { "client::display": { contentType: "text/markdown" } },
  };

  function fakeGotify(over: Partial<Record<string, Response>> = {}) {
    const calls: { method: string; url: string; auth?: string }[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      const auth =
        (init?.headers as Record<string, string> | undefined)?.["X-Gotify-Key"] ??
        (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ method, url, auth });
      const o = over[`${method} ${url}`];
      if (o) return o;
      if (url === `${URL_}/client` && method === "POST") return json(CLIENT);
      if (url.startsWith(`${URL_}/client/`)) return json({}, 200);
      if (url === `${URL_}/current/user`) return json({ id: 3, name: "frodo", admin: true });
      if (url.startsWith(`${URL_}/message?`) || url === `${URL_}/message`) {
        if (method === "DELETE") return json({}, 200);
        return json({ paging: {}, messages: [MSG] });
      }
      if (url === `${URL_}/message/11` && method === "DELETE") return json({}, 200);
      if (url === `${URL_}/application`) return json([{ id: 2, name: "backup", token: "Atok" }]);
      if (url === `${URL_}/application/2` && method === "DELETE") return json({}, 200);
      return json({ error: `unexpected ${method} ${url}` }, 404);
    });
    return { fetchImpl, calls };
  }

  async function connect(app: FastifyInstance, auth: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: "/api/gotify/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring", url: URL_ },
    });
  }

  it("mints a client token via Basic auth and stores only the token", async () => {
    const { fetchImpl, calls } = fakeGotify();
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    const res = await connect(app, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, url: URL_ });
    const create = calls.find((c) => c.url === `${URL_}/client` && c.method === "POST");
    expect(create?.auth).toBe(`Basic ${Buffer.from("frodo:ring").toString("base64")}`);
    const stored = store.getServiceCredential(TEST_USER.sub, "gotify");
    expect(stored?.url).toBe(URL_);
    // Trailing slashes/fragments in the pasted URL are stripped before storage.
    const dirty = await app.inject({
      method: "POST",
      url: "/api/gotify/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring", url: `${URL_}/#` },
    });
    expect(dirty.statusCode).toBe(200);
    expect(store.getServiceCredential(TEST_USER.sub, "gotify")?.url).toBe(URL_);
    // The sealed secret is the client token — the password is nowhere near storage.
    expect(JSON.parse(secrets.open(stored?.secretSealed ?? ""))).toEqual({
      token: "Ctok-abc",
      clientId: 7,
    });
  });

  it("maps a failed upstream login to 401 and stores nothing", async () => {
    const { fetchImpl } = fakeGotify({ [`POST ${URL_}/client`]: json({}, 401) });
    const { app, auth, store } = await testApp({ fetchImpl });
    expect((await connect(app, auth)).statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "gotify")).toBeUndefined();
  });

  it("lists messages with priority and markdown contentType, authed via X-Gotify-Key", async () => {
    const { fetchImpl, calls } = fakeGotify();
    const { app, auth } = await testApp({ fetchImpl });
    await connect(app, auth);
    const res = await app.inject({ method: "GET", url: "/api/gotify/messages", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages).toEqual([
      {
        id: 11,
        appId: 2,
        title: "Backup done",
        message: "**ok** in 3s",
        date: "2026-10-16T10:00:00Z",
        priority: 5,
        contentType: "text/markdown",
      },
    ]);
    const list = calls.find((c) => c.url === `${URL_}/message?limit=50` && c.method === "GET");
    expect(list?.auth).toBe("Ctok-abc");
  });

  it("reports the connected Gotify account via /current/user", async () => {
    const { fetchImpl } = fakeGotify();
    const { app, auth } = await testApp({ fetchImpl });
    await connect(app, auth);
    const res = await app.inject({ method: "GET", url: "/api/gotify/user", headers: auth });
    expect(res.json()).toEqual({ name: "frodo", admin: true });
  });

  it("returns 424 for message routes when not connected", async () => {
    const { fetchImpl } = fakeGotify();
    const { app, auth } = await testApp({ fetchImpl });
    for (const url of [
      "/api/gotify/messages",
      "/api/gotify/applications",
      "/api/gotify/stream",
      "/api/gotify/user",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(424);
    }
    expect(
      (await app.inject({ method: "DELETE", url: "/api/gotify/messages/1", headers: auth }))
        .statusCode,
    ).toBe(424);
  });

  it("deletes one message and all messages upstream", async () => {
    const { fetchImpl } = fakeGotify();
    const { app, auth } = await testApp({ fetchImpl });
    await connect(app, auth);
    expect(
      (
        await app.inject({ method: "DELETE", url: "/api/gotify/messages/11", headers: auth })
      ).json(),
    ).toEqual({ deleted: true });
    expect(
      (await app.inject({ method: "DELETE", url: "/api/gotify/messages", headers: auth })).json(),
    ).toEqual({ deleted: true });
  });

  it("propagates an upstream 404 for unknown message ids", async () => {
    const { fetchImpl } = fakeGotify({
      [`DELETE ${URL_}/message/99`]: json({}, 404),
    });
    const { app, auth } = await testApp({ fetchImpl });
    await connect(app, auth);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/gotify/messages/99", headers: auth }))
        .statusCode,
    ).toBe(404);
  });

  it("lists and creates applications", async () => {
    const { fetchImpl } = fakeGotify({
      [`POST ${URL_}/application`]: json({ id: 5, name: "new", token: "Atok-new" }, 200),
    });
    const { app, auth } = await testApp({ fetchImpl });
    await connect(app, auth);
    const list = await app.inject({
      method: "GET",
      url: "/api/gotify/applications",
      headers: auth,
    });
    expect(list.json()).toEqual({
      applications: [{ id: 2, name: "backup", description: null, token: "Atok" }],
    });
    const create = await app.inject({
      method: "POST",
      url: "/api/gotify/applications",
      headers: auth,
      payload: { name: "new" },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().application.token).toBe("Atok-new");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/gotify/applications",
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it("disconnect deletes the upstream client before dropping the local row", async () => {
    const { fetchImpl, calls } = fakeGotify();
    const { app, auth, store } = await testApp({ fetchImpl });
    await connect(app, auth);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/gotify/credentials",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const del = calls.find((c) => c.url === `${URL_}/client/7` && c.method === "DELETE");
    expect(del?.auth).toBe("Ctok-abc");
    expect(store.getServiceCredential(TEST_USER.sub, "gotify")).toBeUndefined();
  });

  it("exposes gotify tools that answer not_connected without a credential", async () => {
    const { fetchImpl } = fakeGotify();
    const { app, auth } = await testApp({ fetchImpl });
    const toolsRes = await app.inject({ method: "GET", url: "/api/einchat/tools", headers: auth });
    const gotifyTools = toolsRes
      .json()
      .tools.filter((t: { module: string }) => t.module === "gotify");
    expect(gotifyTools.map((t: { name: string }) => t.name)).toEqual([
      "gotify_recent_messages",
      "gotify_applications",
    ]);
  });
});

describe("einhub", () => {
  const GOTIFY_URL = "https://gotify.test";
  const hubEnv = () => ({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" });

  function seedGotify(store: Store, secrets: SecretBox) {
    store.saveServiceCredential({
      sub: TEST_USER.sub,
      service: "gotify",
      url: GOTIFY_URL,
      secretSealed: secrets.seal(JSON.stringify({ token: "tok", clientId: 1 })),
    });
  }

  function seedEmail(store: Store, secrets: SecretBox) {
    store.saveServiceCredential({
      sub: TEST_USER.sub,
      service: "email",
      url: "imaps://imap.test:993",
      secretSealed: secrets.seal(JSON.stringify({ username: "u", password: "p" })),
    });
  }

  const gotifyFetch = (messages: unknown[]) =>
    fakeFetch(async (url) => {
      if (url.startsWith(`${GOTIFY_URL}/message?`)) return json({ paging: {}, messages });
      return json({ error: `unexpected ${url}` }, 404);
    });

  const MSG_1 = {
    id: 11,
    appid: 2,
    title: "Backup done",
    message: "all good",
    date: "2026-10-17T10:00:00Z",
    priority: 5,
  };

  const get = (app: FastifyInstance, auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/einhub/notifications", headers: auth });

  it("answers an empty feed with no sources connected", async () => {
    const { app, auth } = await testApp();
    const res = await get(app, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notifications: [], unread: 0 });
  });

  it("seeds the first poll as read history, then alerts on new items", async () => {
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(hubEnv()),
      fetchImpl: gotifyFetch([MSG_1]),
    });
    seedGotify(store, secrets);
    const first = await get(app, auth);
    expect(first.json()).toEqual({
      notifications: [
        {
          id: 1,
          module: "gotify",
          title: "Backup done",
          body: "all good",
          at: MSG_1.date,
          read: true,
        },
      ],
      unread: 0,
    });
  });

  it("inserts new upstream items as unread and dedupes by source id", async () => {
    const messages = [MSG_1];
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(hubEnv()),
      fetchImpl: gotifyFetch(messages),
    });
    seedGotify(store, secrets);
    await get(app, auth); // seed
    messages.push({ ...MSG_1, id: 12, title: "New push" });
    const second = await get(app, auth);
    expect(second.json().unread).toBe(1);
    expect(second.json().notifications[0]).toMatchObject({
      module: "gotify",
      title: "New push",
      read: false,
    });
    // Same upstream state again → no duplicates.
    const third = await get(app, auth);
    expect(third.json().notifications).toHaveLength(2);
    expect(third.json().unread).toBe(1);
  });

  it("collects email envelopes via the imap source", async () => {
    const imapOpen: ImapOpen = async () => ({
      mailbox: { exists: 1 },
      connect: async () => {},
      logout: async () => {},
      getMailboxLock: async () => ({ release: () => {} }),
      fetch: async function* () {
        yield {
          uid: 42,
          envelope: {
            subject: "Invoice",
            from: [{ name: "Shop" }],
            date: "2026-10-17T09:00:00Z",
          },
        };
      },
      fetchOne: async () => false,
      messageDelete: async () => true,
    });
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(hubEnv()),
      imapOpen,
    });
    seedEmail(store, secrets);
    const res = await get(app, auth);
    expect(res.json().notifications[0]).toMatchObject({
      module: "email",
      title: "Invoice",
      body: "Shop",
    });
  });

  it("survives a broken source", async () => {
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(hubEnv()),
      fetchImpl: fakeFetch(() => json({ error: "down" }, 500)),
    });
    seedGotify(store, secrets);
    const res = await get(app, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notifications: [], unread: 0 });
  });

  it("marks one read and all read; foreign ids answer 404", async () => {
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(hubEnv()),
      fetchImpl: gotifyFetch([
        { ...MSG_1, id: 21 },
        { ...MSG_1, id: 22 },
      ]),
    });
    seedGotify(store, secrets);
    await get(app, auth); // seed both as read
    store.insertNotification({
      sub: TEST_USER.sub,
      module: "gotify",
      sourceId: "23",
      title: "fresh",
      body: null,
      at: "2026-10-17T11:00:00Z",
    });
    const list = await get(app, auth);
    expect(list.json().unread).toBe(1);
    const id = list.json().notifications[0].id as number;
    const read = await app.inject({
      method: "POST",
      url: `/api/einhub/notifications/${id}/read`,
      headers: auth,
    });
    expect(read.json()).toEqual({ read: true });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/einhub/notifications/999/read",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    // A foreign user's notification id is unreachable.
    const foreign = store.insertNotification({
      sub: "other",
      module: "gotify",
      sourceId: "9",
      title: "x",
      body: null,
      at: "2026-10-17T11:00:00Z",
    });
    expect(foreign).toBe(true);
    const foreignId = store.listNotifications("other", 1)[0]?.id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/einhub/notifications/${foreignId}/read`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    const all = await app.inject({
      method: "POST",
      url: "/api/einhub/read-all",
      headers: auth,
    });
    expect(all.json()).toEqual({ unread: 0 });
    expect(store.unreadNotificationCount(TEST_USER.sub)).toBe(0);
  });

  it("throttles upstream refreshes per user", async () => {
    let upstreamCalls = 0;
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig(testEnv()), // default 60s throttle
      fetchImpl: fakeFetch(async (url) => {
        upstreamCalls += 1;
        if (url.startsWith(`${GOTIFY_URL}/message?`))
          return json({ paging: {}, messages: [MSG_1] });
        return json({}, 404);
      }),
    });
    seedGotify(store, secrets);
    await get(app, auth);
    await get(app, auth); // within the throttle window → no second poll
    expect(upstreamCalls).toBe(1);
  });
});

describe("gitlab", () => {
  const URL_ = "https://gitlab.test";
  const TODO = {
    id: 77,
    project: { name: "einring", name_with_namespace: "wit / einring" },
    author: { name: "Sauron" },
    action_name: "assigned",
    target_type: "MergeRequest",
    target: { title: "Add hub" },
    target_url: `${URL_}/wit/einring/-/merge_requests/4`,
    state: "pending",
    created_at: "2026-10-17T12:00:00Z",
  };

  function fakeGitLab(over: Partial<Record<string, Response>> = {}) {
    const calls: { method: string; url: string; token?: string }[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      const token = (init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"];
      calls.push({ method, url, token });
      const o = over[`${method} ${url}`];
      if (o) return o;
      if (url === `${URL_}/api/v4/user`)
        return token === "good-key" ? json({ username: "frodo" }) : json({}, 401);
      if (url.startsWith(`${URL_}/api/v4/todos?`)) return json([TODO]);
      return json({ error: `unexpected ${method} ${url}` }, 404);
    });
    return { fetchImpl, calls };
  }

  const connect = (app: FastifyInstance, auth: Record<string, string>, apiKey = "good-key") =>
    app.inject({
      method: "POST",
      url: "/api/gitlab/credentials",
      headers: auth,
      payload: { apiKey, url: URL_ },
    });

  it("verifies the PAT via /api/v4/user and stores it sealed per sub", async () => {
    const { fetchImpl, calls } = fakeGitLab();
    const { app, auth, store } = await testApp({ fetchImpl });
    const res = await connect(app, auth);
    expect(res.statusCode).toBe(200);
    expect(calls.find((c) => c.url === `${URL_}/api/v4/user`)?.token).toBe("good-key");
    const stored = store.getServiceCredential(TEST_USER.sub, "gitlab");
    expect(stored?.url).toBe(URL_);
    expect(stored?.secretSealed).not.toContain("good-key");
  });

  it("rejects a bad token with 401 and stores nothing", async () => {
    const { app, auth, store } = await testApp({ fetchImpl: fakeGitLab().fetchImpl });
    expect((await connect(app, auth, "bad")).statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "gitlab")).toBeUndefined();
  });

  it("lists pending todos, 424s when unconnected, 502s when unreachable", async () => {
    const { app, auth } = await testApp({ fetchImpl: fakeGitLab().fetchImpl });
    expect(
      (await app.inject({ method: "GET", url: "/api/gitlab/todos", headers: auth })).statusCode,
    ).toBe(424);
    await connect(app, auth);
    const res = await app.inject({ method: "GET", url: "/api/gitlab/todos", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      todos: [
        {
          id: 77,
          project: "wit / einring",
          author: "Sauron",
          action: "assigned",
          targetType: "MergeRequest",
          title: "Add hub",
          url: `${URL_}/wit/einring/-/merge_requests/4`,
          createdAt: TODO.created_at,
        },
      ],
    });
  });

  it("feeds pending todos into einhub notifications", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" }),
      fetchImpl: fakeGitLab().fetchImpl,
    });
    await connect(app, auth);
    const feed = await app.inject({
      method: "GET",
      url: "/api/einhub/notifications",
      headers: auth,
    });
    expect(feed.json().notifications[0]).toMatchObject({
      module: "gitlab",
      title: "assigned: Add hub",
      body: "wit / einring · Sauron",
      at: TODO.created_at,
    });
  });

  it("exposes a gitlab_todos tool that answers not_connected without a credential", async () => {
    const { app, auth } = await testApp({ fetchImpl: fakeGitLab().fetchImpl });
    const toolsRes = await app.inject({ method: "GET", url: "/api/einchat/tools", headers: auth });
    const t = toolsRes
      .json()
      .tools.filter((x: { module: string }) => x.module === "gitlab")
      .map((x: { name: string }) => x.name);
    expect(t).toEqual(["gitlab_todos"]);
  });
});

describe("github", () => {
  const URL_ = "https://github.com";
  const API = "https://api.github.com";
  const THREAD = {
    id: "1507",
    unread: true,
    reason: "review_requested",
    updated_at: "2026-10-17T13:00:00Z",
    subject: {
      title: "Wire einhub",
      url: `${API}/repos/wit/einring/pulls/9`,
      type: "PullRequest",
    },
    repository: { full_name: "wit/einring" },
  };

  function fakeGitHub(over: Partial<Record<string, Response>> = {}) {
    const calls: { method: string; url: string; auth?: string }[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const method = init?.method ?? "GET";
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ method, url, auth });
      const o = over[`${method} ${url}`];
      if (o) return o;
      if (url === `${API}/user`)
        return auth === "Bearer good-key" ? json({ login: "frodo" }) : json({}, 401);
      if (url.startsWith(`${API}/notifications?`)) return json([THREAD]);
      return json({ error: `unexpected ${method} ${url}` }, 404);
    });
    return { fetchImpl, calls };
  }

  const connect = (app: FastifyInstance, auth: Record<string, string>, apiKey = "good-key") =>
    app.inject({
      method: "POST",
      url: "/api/github/credentials",
      headers: auth,
      payload: { apiKey, url: URL_ },
    });

  it("verifies the PAT via /user and stores it sealed per sub", async () => {
    const { fetchImpl, calls } = fakeGitHub();
    const { app, auth, store } = await testApp({ fetchImpl });
    const res = await connect(app, auth);
    expect(res.statusCode).toBe(200);
    expect(calls.find((c) => c.url === `${API}/user`)?.auth).toBe("Bearer good-key");
    const stored = store.getServiceCredential(TEST_USER.sub, "github");
    expect(stored?.url).toBe(URL_);
    expect(stored?.secretSealed).not.toContain("good-key");
  });

  it("rejects a bad token with 401 and stores nothing", async () => {
    const { app, auth, store } = await testApp({ fetchImpl: fakeGitHub().fetchImpl });
    expect((await connect(app, auth, "bad")).statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "github")).toBeUndefined();
  });

  it("lists notification threads with web links, 424s when unconnected", async () => {
    const { app, auth } = await testApp({ fetchImpl: fakeGitHub().fetchImpl });
    expect(
      (await app.inject({ method: "GET", url: "/api/github/notifications", headers: auth }))
        .statusCode,
    ).toBe(424);
    await connect(app, auth);
    const res = await app.inject({
      method: "GET",
      url: "/api/github/notifications",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      notifications: [
        {
          id: "1507",
          unread: true,
          reason: "review_requested",
          title: "Wire einhub",
          type: "PullRequest",
          repo: "wit/einring",
          url: "https://github.com/wit/einring/pulls/9",
          updatedAt: THREAD.updated_at,
        },
      ],
    });
  });

  it("feeds notification threads into einhub", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" }),
      fetchImpl: fakeGitHub().fetchImpl,
    });
    await connect(app, auth);
    const feed = await app.inject({
      method: "GET",
      url: "/api/einhub/notifications",
      headers: auth,
    });
    expect(feed.json().notifications[0]).toMatchObject({
      module: "github",
      title: "review_requested: Wire einhub",
      body: "wit/einring · PullRequest",
      at: THREAD.updated_at,
    });
  });

  it("maps a GHES instance url to its /api/v3 base", async () => {
    const ghe = "https://ghe.corp.test";
    const seen: string[] = [];
    const { app, auth } = await testApp({
      fetchImpl: fakeFetch(async (url) => {
        seen.push(url);
        if (url === `${ghe}/api/v3/user`) return json({ login: "frodo" });
        if (url.startsWith(`${ghe}/api/v3/notifications?`)) return json([]);
        return json({}, 404);
      }),
    });
    await app.inject({
      method: "POST",
      url: "/api/github/credentials",
      headers: auth,
      payload: { apiKey: "k", url: ghe },
    });
    expect(seen[0]).toBe(`${ghe}/api/v3/user`);
  });
});

describe("authentik", () => {
  const URL_ = "https://auth.example.com";
  const API = `${URL_}/api/v3`;

  function fakeAuthentik(over: Record<string, Response> = {}) {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = fakeFetch(async (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      calls.push({ url, auth });
      if (over[url]) return over[url];
      if (auth !== "Bearer good-key") return json({ detail: "denied" }, 403);
      if (url === `${API}/core/users/me/`) return json({ username: "frodo", name: "Frodo B." });
      if (url === `${API}/admin/version/`)
        return json({ version_current: "2025.8.1", version_latest: "2025.8.3", outdated: true });
      if (url === `${API}/core/users/?page_size=1`) return json({ pagination: { count: 42 } });
      if (url === `${API}/core/groups/?page_size=1`) return json({ pagination: { count: 7 } });
      if (url === `${API}/core/applications/?page_size=1`)
        return json({ pagination: { count: 12 } });
      if (url === `${API}/outposts/instances/?page_size=1`)
        return json({ pagination: { count: 2 } });
      if (url === `${API}/admin/system_tasks/?page_size=200`)
        return json([
          { full_name: "clean_expired_models", status: "successful" },
          { full_name: "blueprints_discovery", status: "error" },
        ]);
      if (url === `${API}/admin/workers/`) return json([{ worker_id: "w1" }]);
      if (url === `${API}/events/events/?action=login_failed&page_size=1`)
        return json({ pagination: { count: 5 } });
      if (url === `${API}/events/events/?ordering=-created&page_size=10`)
        return json({
          results: [
            {
              action: "login_failed",
              created: "2026-10-18T10:00:00Z",
              app: "authentik.events",
              user: { username: "mallory" },
            },
          ],
        });
      return json({ error: `unexpected ${url}` }, 404);
    });
    return { fetchImpl, calls };
  }

  const connect = (app: FastifyInstance, auth: Record<string, string>, apiKey = "good-key") =>
    app.inject({
      method: "POST",
      url: "/api/authentik/credentials",
      headers: auth,
      payload: { apiKey, url: URL_ },
    });

  it("verifies the token via /core/users/me/ and stores it sealed", async () => {
    const { fetchImpl, calls } = fakeAuthentik();
    const { app, auth, store } = await testApp({ fetchImpl });
    expect((await connect(app, auth)).statusCode).toBe(200);
    expect(calls.find((c) => c.url.endsWith("/core/users/me/"))?.auth).toBe("Bearer good-key");
    const stored = store.getServiceCredential(TEST_USER.sub, "authentik");
    expect(stored?.secretSealed).not.toContain("good-key");
  });

  it("rejects a bad token with 401 and stores nothing", async () => {
    const { app, auth, store } = await testApp({ fetchImpl: fakeAuthentik().fetchImpl });
    expect((await connect(app, auth, "bad")).statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "authentik")).toBeUndefined();
  });

  it("aggregates the health snapshot; 424 when unconnected", async () => {
    const { app, auth } = await testApp({ fetchImpl: fakeAuthentik().fetchImpl });
    expect(
      (await app.inject({ method: "GET", url: "/api/authentik/health", headers: auth })).statusCode,
    ).toBe(424);
    await connect(app, auth);
    const res = await app.inject({ method: "GET", url: "/api/authentik/health", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account).toEqual({ username: "frodo", name: "Frodo B." });
    expect(body.version).toEqual({ current: "2025.8.1", latest: "2025.8.3", outdated: true });
    expect(body.counts).toEqual({ users: 42, groups: 7, applications: 12, outposts: 2 });
    expect(body.workers).toBe(1);
    expect(body.tasks).toEqual({
      total: 2,
      failed: 1,
      failedNames: ["blueprints_discovery"],
    });
    expect(body.events.loginFailedTotal).toBe(5);
    expect(body.events.recent[0]).toMatchObject({
      action: "login_failed",
      user: "mallory",
    });
  });

  it("degrades per-field when the token lacks admin rights", async () => {
    const { app, auth } = await testApp({
      fetchImpl: fakeFetch(async (url, init) => {
        const authz = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (authz !== "Bearer user-token") return json({}, 403);
        if (url.endsWith("/core/users/me/")) return json({ username: "sam" });
        if (url.includes("/admin/")) return json({ detail: "denied" }, 403);
        if (url.endsWith("/core/users/?page_size=1")) return json({ pagination: { count: 3 } });
        return json({ detail: "denied" }, 403);
      }),
    });
    await connect(app, auth, "user-token");
    const res = await app.inject({ method: "GET", url: "/api/authentik/health", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account.username).toBe("sam");
    expect(body.version).toBeNull();
    expect(body.counts.users).toBe(3);
    expect(body.counts.groups).toBeNull();
    expect(body.workers).toBeNull();
    expect(body.tasks).toBeNull();
    expect(body.events).toBeNull();
  });
});

describe("nextcloud settings", () => {
  const get = (app: FastifyInstance, auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/nextcloud/settings", headers: auth });
  const put = (app: FastifyInstance, auth: Record<string, string>, body: unknown) =>
    app.inject({
      method: "PUT",
      url: "/api/nextcloud/settings",
      headers: auth,
      payload: body as Record<string, unknown>,
    });

  it("returns all-true defaults before any write", async () => {
    const { app, auth } = await testApp();
    const res = await get(app, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      monitorTalk: true,
      monitorServer: true,
      tables: true,
      wiki: true,
    });
  });

  it("merges partial writes and keeps them per user", async () => {
    const { app, auth } = await testApp({
      verifyToken: async (token) => (token === "other-token" ? { sub: "other-user" } : TEST_USER),
    });
    const res = await put(app, auth, { tables: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toMatchObject({ tables: false, wiki: true });
    expect((await get(app, auth)).json().settings.tables).toBe(false);

    const other = await app.inject({
      method: "GET",
      url: "/api/nextcloud/settings",
      headers: { authorization: "Bearer other-token" },
    });
    expect(other.json().settings.tables).toBe(true);
  });

  it("rejects unknown keys and non-boolean values", async () => {
    const { app, auth } = await testApp();
    expect((await put(app, auth, { monitorTalk: "yes" })).statusCode).toBe(400);
    expect((await put(app, auth, { files: true })).statusCode).toBe(400);
  });
});

describe("settings (module activation)", () => {
  const get = (app: FastifyInstance, auth: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/settings/modules", headers: auth });
  const put = (app: FastifyInstance, auth: Record<string, string>, body: unknown) =>
    app.inject({
      method: "PUT",
      url: "/api/settings/modules",
      headers: auth,
      payload: body as Record<string, unknown>,
    });

  it("starts empty, persists a disabled set, and replaces it on PUT", async () => {
    const { app, auth } = await testApp();
    expect((await get(app, auth)).json().disabled).toEqual([]);
    const res = await put(app, auth, { disabled: ["wiki", "tables"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().disabled).toEqual(["wiki", "tables"]);
    expect((await get(app, auth)).json().disabled).toEqual(["wiki", "tables"]);
    await put(app, auth, { disabled: [] });
    expect((await get(app, auth)).json().disabled).toEqual([]);
  });

  it("rejects unknown ids, einhub, and non-string entries", async () => {
    const { app, auth } = await testApp();
    expect((await put(app, auth, { disabled: ["nope"] })).statusCode).toBe(400);
    expect((await put(app, auth, { disabled: ["einhub"] })).statusCode).toBe(400);
    expect((await put(app, auth, { disabled: [42] })).statusCode).toBe(400);
    expect((await get(app, auth)).json().disabled).toEqual([]);
  });
});

describe("einmusic", () => {
  const MP3 = Buffer.from("FAKEMP3DATA!!");
  const mkDir = () => mkdtempSync(join(tmpdir(), "einmusic-"));
  const musicApp = (overrides: Partial<AppDeps> = {}) =>
    testApp({ config: loadConfig({ ...testEnv(), DATA_DIR: mkDir() }), ...overrides });

  const upload = (app: FastifyInstance, auth: Record<string, string>, name = "Song One.mp3") =>
    app.inject({
      method: "POST",
      url: `/api/einmusic/tracks?name=${encodeURIComponent(name)}`,
      headers: { ...auth, "content-type": "audio/mpeg" },
      payload: MP3,
    });

  it("uploads, lists, streams (full + range), and deletes a track", async () => {
    const dir = mkDir();
    const { app, auth } = await testApp({ config: loadConfig({ ...testEnv(), DATA_DIR: dir }) });
    const up = await upload(app, auth, "Frodo - Ring Theme.mp3");
    expect(up.statusCode).toBe(201);
    const track = up.json().track;
    expect(track.title).toBe("Ring Theme");
    expect(track.bytes).toBe(MP3.length);
    expect(existsSync(join(dir, "einmusic", `${track.id}.mp3`))).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/einmusic/tracks", headers: auth });
    expect(list.json().tracks).toHaveLength(1);

    const full = await app.inject({
      method: "GET",
      url: `/api/einmusic/tracks/${track.id}/stream`,
      headers: auth,
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers["content-type"]).toBe("audio/mpeg");
    expect(full.body).toBe(MP3.toString());

    const part = await app.inject({
      method: "GET",
      url: `/api/einmusic/tracks/${track.id}/stream`,
      headers: { ...auth, range: "bytes=0-3" },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-3/${MP3.length}`);
    expect(part.body).toBe("FAKE");

    const bad = await app.inject({
      method: "GET",
      url: `/api/einmusic/tracks/${track.id}/stream`,
      headers: { ...auth, range: "bytes=99-100" },
    });
    expect(bad.statusCode).toBe(416);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/einmusic/tracks/${track.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(200);
    expect(existsSync(join(dir, "einmusic", `${track.id}.mp3`))).toBe(false);
    const rel = await app.inject({ method: "GET", url: "/api/einmusic/tracks", headers: auth });
    expect(rel.json().tracks).toHaveLength(0);
  });

  it("scopes tracks and playlists per user; 404s foreign ids", async () => {
    const { app, auth } = await musicApp({
      verifyToken: async (token) => (token === "other" ? { sub: "other" } : TEST_USER),
    });
    await upload(app, auth);
    const foreign = await app.inject({
      method: "GET",
      url: "/api/einmusic/tracks/1/stream",
      headers: { authorization: "Bearer other" },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it("creates playlists, replaces tracks atomically, rejects foreign track ids", async () => {
    const { app, auth } = await musicApp();
    const t1 = (await upload(app, auth, "a.mp3")).json().track.id;
    const t2 = (await upload(app, auth, "b.mp3")).json().track.id;
    const pl = (
      await app.inject({
        method: "POST",
        url: "/api/einmusic/playlists",
        headers: auth,
        payload: { name: "Road" },
      })
    ).json().playlist;
    expect(pl.name).toBe("Road");

    const put = await app.inject({
      method: "PUT",
      url: `/api/einmusic/playlists/${pl.id}`,
      headers: auth,
      payload: { trackIds: [t2, t1] },
    });
    expect(put.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/api/einmusic/playlists/${pl.id}`,
      headers: auth,
    });
    expect(detail.json().tracks.map((t: { id: number }) => t.id)).toEqual([t2, t1]);

    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/einmusic/playlists/${pl.id}`,
          headers: auth,
          payload: { trackIds: [999] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/einmusic/playlists/${pl.id}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/einmusic/playlists/${pl.id}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("bridges navidrome playlists + streams via the sealed credential; 424 without it", async () => {
    const { app, auth, store, secrets } = await musicApp({
      fetchImpl: fakeFetch(async (url) => {
        if (url.includes("/rest/getPlaylists.view")) {
          return json({
            "subsonic-response": {
              status: "ok",
              playlists: { playlist: [{ id: "p1", name: "Mix", songCount: 2 }] },
            },
          });
        }
        if (url.includes("/rest/getPlaylist.view")) {
          return json({
            "subsonic-response": {
              status: "ok",
              playlist: {
                id: "p1",
                name: "Mix",
                entry: [{ id: "s1", title: "One", artist: "A", album: "B", duration: 61 }],
              },
            },
          });
        }
        if (url.includes("/rest/stream.view")) {
          return new Response(MP3, {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
        }
        return json({ error: `unexpected ${url}` }, 404);
      }),
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/einmusic/navidrome/playlists",
          headers: auth,
        })
      ).statusCode,
    ).toBe(424);

    store.saveServiceCredential({
      sub: TEST_USER.sub,
      service: "navidrome",
      url: "https://music.test",
      secretSealed: secrets.seal(JSON.stringify({ username: "frodo", password: "ring" })),
    });

    const pls = await app.inject({
      method: "GET",
      url: "/api/einmusic/navidrome/playlists",
      headers: auth,
    });
    expect(pls.json().playlists).toEqual([{ id: "p1", name: "Mix", songCount: 2 }]);
    const detail = await app.inject({
      method: "GET",
      url: "/api/einmusic/navidrome/playlists/p1",
      headers: auth,
    });
    expect(detail.json().tracks[0]).toMatchObject({ id: "s1", title: "One", artist: "A" });
    const stream = await app.inject({
      method: "GET",
      url: "/api/einmusic/navidrome/stream?songId=s1",
      headers: auth,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toBe(MP3.toString());
  });
});

describe("passman", () => {
  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    expect(
      (await app.inject({ method: "GET", url: "/api/passman/vaults", headers: auth })).statusCode,
    ).toBe(424);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/passman/vaults/GUID-1",
          headers: auth,
        })
      ).statusCode,
    ).toBe(424);
  });

  it("proxies vaults and vault credentials verbatim", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "https://cloud.test/index.php/apps/passman/api/v2/vaults") {
        return json([
          {
            vault_id: 3,
            guid: "AAAA-BBBB",
            name: "Work",
            challenge_password: "enc==",
          },
        ]);
      }
      if (url === "https://cloud.test/index.php/apps/passman/api/v2/vaults/AAAA-BBBB") {
        return json({
          guid: "AAAA-BBBB",
          name: "Work",
          credentials: [{ credential_id: 9, label: "mail", username: "frodo", password: "enc-pw" }],
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);

    const vaults = await app.inject({
      method: "GET",
      url: "/api/passman/vaults",
      headers: auth,
    });
    expect(vaults.statusCode).toBe(200);
    expect(vaults.json().vaults[0]).toMatchObject({ guid: "AAAA-BBBB", name: "Work" });

    const vault = await app.inject({
      method: "GET",
      url: "/api/passman/vaults/AAAA-BBBB",
      headers: auth,
    });
    expect(vault.statusCode).toBe(200);
    expect(vault.json().vault.credentials[0].label).toBe("mail");
    // Encrypted fields pass through untouched — decryption is app-side only (D50).
    expect(vault.json().vault.credentials[0].password).toBe("enc-pw");
  });

  it("maps upstream failures through the global NextcloudError handler", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/apps/passman/")) return json({ error: "nope" }, 401);
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/passman/vaults", headers: auth });
    expect(res.statusCode).toBe(424);
    expect(res.json().error).toBe("nextcloud");
  });
});

describe("talk", () => {
  const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic

  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    for (const url of [
      "/api/talk/rooms",
      "/api/talk/rooms/t1/messages",
      "/api/talk/file?path=Talk/a.png",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(424);
    }
  });

  it("lists rooms trimmed", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "https://cloud.test/ocs/v2.php/apps/spreed/api/v4/room") {
        return json({
          ocs: {
            meta: { status: "ok", statuscode: 200 },
            data: [
              {
                token: "t1",
                type: 1,
                name: "sam",
                displayName: "Sam",
                unreadMessages: 3,
                lastActivity: 1700000000,
                lastMessage: { message: "hi" },
              },
            ],
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/talk/rooms", headers: auth });
    expect(res.json().rooms).toEqual([
      {
        token: "t1",
        name: "sam",
        displayName: "Sam",
        type: 1,
        unread: 3,
        lastActivity: 1700000000,
        lastMessage: "hi",
      },
    ]);
  });

  it("fetches history without moving the read marker", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.startsWith("https://cloud.test/ocs/v2.php/apps/spreed/api/v1/chat/t1")) {
        expect(url).toContain("lookIntoFuture=0");
        expect(url).toContain("setReadMarker=0");
        return json({
          ocs: {
            meta: { status: "ok", statuscode: 200 },
            data: [
              { id: 5, actorId: "sam", actorDisplayName: "Sam", timestamp: 100, message: "hi" },
            ],
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({
      method: "GET",
      url: "/api/talk/rooms/t1/messages?lastKnown=4",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().messages[0].message).toBe("hi");
  });

  it("sends a text message with a generated referenceId", async () => {
    const posted: { url: string; body: string }[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      if (
        url === "https://cloud.test/ocs/v2.php/apps/spreed/api/v1/chat/t1" &&
        init?.method === "POST"
      ) {
        posted.push({ url, body: String(init.body) });
        return json({ ocs: { meta: { status: "ok", statuscode: 201 }, data: { id: 9 } } }, 201);
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({
      method: "POST",
      url: "/api/talk/rooms/t1/messages",
      headers: auth,
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(posted[0]?.body ?? "{}") as { message: string; referenceId: string };
    expect(body.message).toBe("hello");
    expect(body.referenceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uploads an image to Talk/ then shares it into the room", async () => {
    const seen: { method?: string; url: string }[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      seen.push({ method: init?.method, url });
      if (init?.method === "MKCOL") return new Response(null, { status: 405 });
      if (init?.method === "PUT" && url.includes("/Talk/")) {
        return new Response(null, { status: 201 });
      }
      if (url === "https://cloud.test/ocs/v2.php/apps/files_sharing/api/v1/shares") {
        const b = JSON.parse(String(init?.body)) as {
          shareType: number;
          shareWith: string;
          path: string;
        };
        expect(b.shareType).toBe(10);
        expect(b.shareWith).toBe("t1");
        expect(b.path).toMatch(/^\/Talk\/\d+-pic\.png$/);
        return json({ ocs: { meta: { status: "ok", statuscode: 200 }, data: { id: 77 } } });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const res = await app.inject({
      method: "POST",
      url: "/api/talk/rooms/t1/image?name=pic.png",
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: PNG,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path).toMatch(/^Talk\/\d+-pic\.png$/);
    const order = seen.map(
      (s) => `${s.method}:${new URL(s.url).pathname.split("/dav/")[1] ?? s.url}`,
    );
    expect(order[0]).toContain("MKCOL");
    expect(order[1]).toContain("PUT");
    expect(order[2]).toContain("shares");
  });

  it("proxies shared files and rejects path traversal", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/dav/files/frodo/Talk/pic.png")) {
        return new Response(PNG, { status: 200 });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    connect(store, secrets);
    const ok = await app.inject({
      method: "GET",
      url: "/api/talk/file?path=Talk/pic.png",
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(ok.body).toBe(PNG.toString());
    const bad = await app.inject({
      method: "GET",
      url: "/api/talk/file?path=../etc/passwd",
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });

  it("feeds unread rooms to einhub", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === "https://cloud.test/ocs/v2.php/apps/spreed/api/v4/room") {
        return json({
          ocs: {
            meta: { status: "ok", statuscode: 200 },
            data: [
              { token: "t1", displayName: "Sam", unreadMessages: 2, lastActivity: 1700000000 },
              { token: "t2", displayName: "Quiet", unreadMessages: 0 },
            ],
          },
        });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({
      fetchImpl,
      config: loadConfig({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" }),
    });
    connect(store, secrets);
    const first = await app.inject({
      method: "GET",
      url: "/api/einhub/notifications",
      headers: auth,
    });
    expect(first.json().unread).toBe(0); // seed pass marks existing as read
    const second = await app.inject({
      method: "GET",
      url: "/api/einhub/notifications",
      headers: auth,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().notifications.every((n: { module: string }) => n.module === "talk")).toBe(
      true,
    );
  });
});

describe("matrix", () => {
  const HS = "https://matrix.test";
  const TOK_SECRET = JSON.stringify({ accessToken: "tok-abc", userId: "@frodo:matrix.test" });

  /** Seed a sealed matrix credential (post-login shape, D52). */
  const seedMatrix = (store: Store, secrets: SecretBox) =>
    store.saveServiceCredential({
      sub: TEST_USER.sub,
      service: "matrix",
      url: HS,
      secretSealed: secrets.seal(TOK_SECRET),
    });

  it("exchanges username+password for an access token on connect", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      if (url === `${HS}/_matrix/client/v3/login` && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          type: string;
          user: string;
          password: string;
        };
        expect(body.type).toBe("m.login.password");
        expect(body.user).toBe("frodo");
        return json({ access_token: "tok-abc", user_id: "@frodo:matrix.test", device_id: "DEV" });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    const res = await app.inject({
      method: "POST",
      url: "/api/matrix/credentials",
      headers: auth,
      payload: { username: "frodo", password: "ring", url: HS },
    });
    expect(res.statusCode).toBe(200);
    // The sealed secret is the token — the password is never stored (D52).
    const stored = store.getServiceCredential(TEST_USER.sub, "matrix");
    const opened = secrets.open(stored?.secretSealed ?? "");
    expect(JSON.parse(opened).accessToken).toBe("tok-abc");
    expect(opened).not.toContain("ring");
  });

  it("rejects a bad login without storing anything", async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.includes("/_matrix/client/v3/login")) return json({ error: "forbidden" }, 403);
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store } = await testApp({ fetchImpl });
    const res = await app.inject({
      method: "POST",
      url: "/api/matrix/credentials",
      headers: auth,
      payload: { username: "frodo", password: "wrong", url: HS },
    });
    expect(res.statusCode).toBe(401);
    expect(store.getServiceCredential(TEST_USER.sub, "matrix")).toBeUndefined();
  });

  it("424s on all routes when not connected", async () => {
    const { app, auth } = await testApp();
    for (const url of [
      "/api/matrix/me",
      "/api/matrix/rooms",
      "/api/matrix/rooms/!r1:hs/messages",
      "/api/matrix/media?mxc=mxc://s/id",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(424);
    }
  });

  it("lists joined rooms with resolved names", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      const authz = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authz).toBe("Bearer tok-abc");
      if (url === `${HS}/_matrix/client/v3/joined_rooms`) {
        return json({ joined_rooms: ["!r1:hs", "!r2:hs"] });
      }
      if (url === `${HS}/_matrix/client/v3/rooms/!r1%3Ahs/state/m.room.name`) {
        return json({ name: "Shire" });
      }
      if (url === `${HS}/_matrix/client/v3/rooms/!r2%3Ahs/state/m.room.name`) {
        return json({ error: "no name" }, 404);
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    seedMatrix(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/matrix/rooms", headers: auth });
    expect(res.json().rooms).toEqual([
      { id: "!r1:hs", name: "Shire" },
      { id: "!r2:hs", name: null },
    ]);
    const me = await app.inject({ method: "GET", url: "/api/matrix/me", headers: auth });
    expect(me.json()).toEqual({ userId: "@frodo:matrix.test" });
  });

  it("fetches backwards history and sends text with a txn id", async () => {
    const seen: { method?: string; url: string; body: unknown }[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      seen.push({ method: init?.method, url, body: init?.body });
      if (url.includes("/rooms/!r1%3Ahs/messages?")) {
        return json({
          chunk: [
            {
              event_id: "$e2",
              sender: "@sam:hs",
              origin_server_ts: 200,
              type: "m.room.message",
              content: { msgtype: "m.text", body: "newest" },
            },
          ],
          end: "tok-end",
        });
      }
      if (url.includes("/send/m.room.message/")) {
        return json({ event_id: "$e3" });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    seedMatrix(store, secrets);

    const msgs = await app.inject({
      method: "GET",
      url: "/api/matrix/rooms/!r1:hs/messages",
      headers: auth,
    });
    expect(msgs.statusCode).toBe(200);
    expect(msgs.json().messages[0]).toMatchObject({
      sender: "@sam:hs",
      senderName: "sam",
      msgtype: "m.text",
      body: "newest",
    });
    expect(msgs.json().end).toBe("tok-end");

    const send = await app.inject({
      method: "POST",
      url: "/api/matrix/rooms/!r1:hs/messages",
      headers: auth,
      payload: { text: "hello" },
    });
    expect(send.statusCode).toBe(201);
    const putCall = seen.find((s) => s.method === "PUT");
    const putBody = JSON.parse(String(putCall?.body)) as { msgtype: string; body: string };
    expect(putBody).toEqual({ msgtype: "m.text", body: "hello" });
  });

  it("uploads a file to media/v3 then posts an m.image message", async () => {
    const seen: { method?: string; url: string; body: unknown }[] = [];
    const fetchImpl = fakeFetch((url, init) => {
      seen.push({ method: init?.method, url, body: init?.body });
      if (url.includes("/_matrix/media/v3/upload")) {
        return json({ content_uri: "mxc://hs/media123" });
      }
      if (url.includes("/send/m.room.message/")) {
        return json({ event_id: "$e4" });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    seedMatrix(store, secrets);
    const res = await app.inject({
      method: "POST",
      url: "/api/matrix/rooms/!r1:hs/file?name=pic.png",
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: Buffer.from("pngdata"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().mxc).toBe("mxc://hs/media123");
    const sendBody = JSON.parse(String(seen.find((s) => s.url.includes("/send/"))?.body)) as {
      msgtype: string;
      url: string;
      info: { size: number };
    };
    expect(sendBody.msgtype).toBe("m.image");
    expect(sendBody.url).toBe("mxc://hs/media123");
    expect(sendBody.info.size).toBe(7);
  });

  it("proxies mxc media bytes and rejects non-mxc URIs", async () => {
    const PIX = Buffer.from("89504e47", "hex");
    const fetchImpl = fakeFetch((url) => {
      if (url === `${HS}/_matrix/media/v3/download/hs/media123`) {
        return new Response(PIX, { status: 200, headers: { "content-type": "image/png" } });
      }
      return json({ error: `unexpected ${url}` }, 404);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    seedMatrix(store, secrets);
    const ok = await app.inject({
      method: "GET",
      url: "/api/matrix/media?mxc=mxc://hs/media123",
      headers: auth,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    const bad = await app.inject({
      method: "GET",
      url: "/api/matrix/media?mxc=https://evil.test/x",
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("eindav", () => {
  const NC = "https://cloud.test";
  const ABHOME = "/remote.php/dav/addressbooks/users/frodo/";
  const ABS = `${ABHOME}personal/`;
  const CAL = "/remote.php/dav/calendars/users/frodo/personal/";

  const MS = (bodies: string) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav">
${bodies}</d:multistatus>`;

  it("424s on all routes when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    for (const url of [
      "/api/eindav/addressbooks",
      "/api/eindav/contacts?book=/remote.php/dav/x/",
      "/api/eindav/calendars",
      "/api/eindav/events?cal=/remote.php/dav/x/",
      "/api/eindav/files",
    ]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(424);
    }
  });

  it("lists addressbooks via PROPFIND on the addressbook home", async () => {
    const { app, auth, store, secrets } = await testApp({
      fetchImpl: fakeFetch((url, init) => {
        if (url === `${NC}${ABHOME}` && init?.method === "PROPFIND") {
          return new Response(
            MS(
              `<d:response><d:href>${ABS}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
            { status: 207 },
          );
        }
        return new Response("unexpected " + url, { status: 404 });
      }),
    });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/eindav/addressbooks", headers: auth });
    expect(res.json()).toEqual({ addressbooks: [{ href: ABS, name: "Contacts" }] });
  });

  it("REPORTs contacts, parses vCards, and PUTs a composed vCard", async () => {
    const VCARD =
      "BEGIN:VCARD\\r\\nVERSION:3.0\\r\\nFN:Frodo Baggins\\r\\nEMAIL;TYPE=INTERNET:frodo@shire.me\\r\\nTEL;TYPE=CELL:+123\\r\\nEND:VCARD\\r\\n".replaceAll(
        "\\r\\n",
        "\r\n",
      );
    const seen: { url: string; method?: string; body: unknown }[] = [];
    const { app, auth, store, secrets } = await testApp({
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, method: init?.method, body: init?.body });
        if (url === `${NC}${ABS}` && init?.method === "REPORT") {
          return new Response(
            MS(
              `<d:response><d:href>${ABS}f1.vcf</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><card:address-data>${VCARD.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
            { status: 207 },
          );
        }
        if (init?.method === "PUT" && url.endsWith(".vcf"))
          return new Response("", { status: 201 });
        return new Response("unexpected " + url, { status: 404 });
      }),
    });
    connect(store, secrets);
    const list = await app.inject({
      method: "GET",
      url: `/api/eindav/contacts?book=${encodeURIComponent(ABS)}`,
      headers: auth,
    });
    expect(list.json().contacts[0]).toMatchObject({
      fn: "Frodo Baggins",
      emails: ["frodo@shire.me"],
      tels: ["+123"],
      etag: "e1",
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/eindav/contact",
      headers: auth,
      payload: {
        book: ABS,
        fn: "Samwise Gamgee",
        emails: ["sam@shire.me"],
        tels: [],
        note: "gardener",
      },
    });
    expect(put.statusCode).toBe(201);
    const putCall = seen.find((s) => s.method === "PUT");
    const body = String(putCall?.body);
    expect(body).toContain("FN:Samwise Gamgee");
    expect(body).toContain("EMAIL;TYPE=INTERNET:sam@shire.me");
    expect(body).toContain("NOTE:gardener");
    expect(putCall?.url).toMatch(/personal\/einring-[0-9a-f]+\.vcf$/);
  });

  it("REPORTs VEVENTs in a time-range and PUTs a composed iCalendar", async () => {
    const ICS =
      "BEGIN:VCALENDAR\\r\\nBEGIN:VEVENT\\r\\nUID:e-1\\r\\nDTSTART:20261020T100000Z\\r\\nDTEND:20261020T110000Z\\r\\nSUMMARY:Elevenses\\r\\nLOCATION:The Green Dragon\\r\\nEND:VEVENT\\r\\nEND:VCALENDAR\\r\\n".replaceAll(
        "\\r\\n",
        "\r\n",
      );
    const seen: { url: string; method?: string; body: unknown }[] = [];
    const { app, auth, store, secrets } = await testApp({
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, method: init?.method, body: init?.body });
        if (url === `${NC}${CAL}` && init?.method === "REPORT") {
          const body = String(init.body);
          expect(body).toContain('time-range start="20261001T000000Z" end="20261031T235900Z"');
          return new Response(
            MS(
              `<d:response><d:href>${CAL}e1.ics</d:href><d:propstat><d:prop><d:getetag>"x"</d:getetag><cal:calendar-data>${ICS.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
            { status: 207 },
          );
        }
        if (init?.method === "PUT" && url.endsWith(".ics"))
          return new Response("", { status: 201 });
        return new Response("unexpected " + url, { status: 404 });
      }),
    });
    connect(store, secrets);
    const list = await app.inject({
      method: "GET",
      url: `/api/eindav/events?cal=${encodeURIComponent(CAL)}&from=2026-10-01&to=2026-10-31`,
      headers: auth,
    });
    expect(list.json().events[0]).toMatchObject({
      uid: "e-1",
      summary: "Elevenses",
      location: "The Green Dragon",
      start: "2026-10-20T10:00",
      end: "2026-10-20T11:00",
    });
    const put = await app.inject({
      method: "PUT",
      url: "/api/eindav/event",
      headers: auth,
      payload: {
        cal: CAL,
        summary: "Second breakfast",
        start: "2026-10-21T09:00",
        end: "2026-10-21T09:30",
      },
    });
    expect(put.statusCode).toBe(201);
    const body = String(seen.find((s) => s.method === "PUT")?.body);
    expect(body).toContain("DTSTART:20261021T090000Z");
    expect(body).toContain("DTEND:20261021T093000Z");
    expect(body).toContain("SUMMARY:Second breakfast");
  });

  it("browses, downloads, uploads and deletes WebDAV files", async () => {
    const FILES = "/remote.php/dav/files/frodo";
    const seen: { url: string; method?: string }[] = [];
    const { app, auth, store, secrets } = await testApp({
      fetchImpl: fakeFetch((url, init) => {
        seen.push({ url, method: init?.method });
        if (url === `${NC}${FILES}` && init?.method === "PROPFIND") {
          return new Response(
            MS(`<d:response><d:href>${FILES}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>${FILES}/notes.txt</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>5</d:getcontentlength><d:getcontenttype>text/plain</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`),
            { status: 207 },
          );
        }
        if (url === `${NC}${FILES}/notes.txt` && (init?.method ?? "GET") === "GET") {
          return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
        }
        if (url === `${NC}${FILES}/up.bin` && init?.method === "PUT") {
          return new Response("", { status: 201 });
        }
        if (url === `${NC}${FILES}/notes.txt` && init?.method === "DELETE") {
          return new Response("", { status: 200 });
        }
        return new Response("unexpected " + url, { status: 404 });
      }),
    });
    connect(store, secrets);
    const list = await app.inject({ method: "GET", url: "/api/eindav/files?path=", headers: auth });
    expect(list.json().entries).toEqual([
      { name: "notes.txt", path: "notes.txt", isDir: false, size: 5, mtime: null },
    ]);
    const dl = await app.inject({
      method: "GET",
      url: "/api/eindav/file?path=notes.txt",
      headers: auth,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toContain("text/plain");
    const up = await app.inject({
      method: "PUT",
      url: "/api/eindav/file?path=up.bin",
      headers: { ...auth, "content-type": "application/octet-stream" },
      payload: Buffer.from("bin"),
    });
    expect(up.statusCode).toBe(201);
    const del = await app.inject({
      method: "DELETE",
      url: "/api/eindav/file?path=notes.txt",
      headers: auth,
    });
    expect(del.statusCode, del.body).toBe(204);
    const trav = await app.inject({
      method: "GET",
      url: "/api/eindav/file?path=..%2Fsecret",
      headers: auth,
    });
    expect(trav.statusCode).toBe(400);
  });

  it("rejects object hrefs outside /remote.php/dav/", async () => {
    const { app, auth, store, secrets } = await testApp();
    connect(store, secrets);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/eindav/contact?href=" + encodeURIComponent("https://evil.test/x.vcf"),
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("exposes addressbook contacts to EinChat via the eindav_contacts tool", async () => {
    const VCARD =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ulrike Kaiser\r\nEMAIL;TYPE=INTERNET:ulrike@example.org\r\nTEL;TYPE=CELL:+49 30 123\r\nEND:VCARD\r\n";
    const calls: {
      body: { messages?: { role: string; content?: string; tool_call_id?: string }[] };
    }[] = [];
    const { app, auth, store, secrets } = await testApp({
      config: loadConfig({
        ...testEnv(),
        LLM_URL: "https://llm.test/v1",
        LLM_API_KEY: "sk-secret",
        LLM_CHAT_MODEL: "chat-m",
        LLM_EMBED_MODEL: "embed-m",
      }),
      fetchImpl: fakeFetch((url, init) => {
        if (url === "https://llm.test/v1/chat/completions") {
          const body = JSON.parse(String(init?.body));
          calls.push({ body });
          if (calls.length === 1) {
            return json({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: {
                          name: "eindav_contacts",
                          arguments: JSON.stringify({ query: "ulrike" }),
                        },
                      },
                    ],
                  },
                },
              ],
            });
          }
          return json({ choices: [{ message: { role: "assistant", content: "+49 30 123" } }] });
        }
        if (url === `${NC}${ABHOME}` && init?.method === "PROPFIND") {
          return new Response(
            MS(
              `<d:response><d:href>${ABS}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
            { status: 207 },
          );
        }
        if (url === `${NC}${ABS}` && init?.method === "REPORT") {
          return new Response(
            MS(
              `<d:response><d:href>${ABS}u1.vcf</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><card:address-data>${VCARD}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
            ),
            { status: 207 },
          );
        }
        return new Response(`unexpected ${url}`, { status: 404 });
      }),
    });
    connect(store, secrets);
    const res = await app.inject({
      method: "POST",
      url: "/api/einchat/message",
      headers: auth,
      payload: { messages: [{ role: "user", content: "Ulrike Kaiser's number?" }] },
    });
    expect(res.statusCode).toBe(200);
    const toolMsg = calls[1]?.body.messages?.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("call-1");
    expect(toolMsg?.content).toContain("Ulrike Kaiser");
    expect(toolMsg?.content).toContain("+49 30 123");
    expect(toolMsg?.content).not.toContain("app-pw-secret");
  });
});

describe("recipes", () => {
  const NC = "https://cloud.test";
  const FILES = "/remote.php/dav/files/frodo";
  const RECIPE = (name: string, extra = "") =>
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Recipe",
      name,
      description: `${name} desc`,
      keywords: "cake, dessert",
      recipeCategory: "Dessert",
      recipeYield: "8",
      totalTime: "PT1H10M",
      recipeIngredient: ["200g flour", "3 eggs"],
      recipeInstructions: [
        "Mix.",
        { "@type": "HowToStep", text: "Bake." },
        { "@type": "HowToSection", itemListElement: [{ "@type": "HowToStep", text: "Cool." }] },
      ],
      image: "full.jpg",
      ...JSON.parse(extra || "{}"),
    });

  const MS2 = (bodies: string) => `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
${bodies}</d:multistatus>`;

  /** PROPFIND of Recipes/ with two recipe folders (Bolo has an image, Pasta none). */
  const recipesPropfind = MS2(`
<d:response><d:href>${FILES}/Recipes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>${FILES}/Recipes/Bolo/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
<d:response><d:href>${FILES}/Recipes/Pasta/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);

  const recipesFake = fakeFetch((url, init) => {
    if (url === `${NC}${FILES}/Recipes` && init?.method === "PROPFIND") {
      return new Response(recipesPropfind, { status: 207 });
    }
    if (url === `${NC}${FILES}/Recipes/Bolo/recipe.json` && !init?.method) {
      return new Response(RECIPE("Bolo"), { status: 200 });
    }
    if (url === `${NC}${FILES}/Recipes/Pasta/recipe.json` && !init?.method) {
      return new Response(RECIPE("Pasta", '{"image":null}'), { status: 200 });
    }
    if (url === `${NC}${FILES}/Recipes/Bolo/full.jpg` && !init?.method) {
      return new Response("jpeg-bytes", {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response(`unexpected ${url}`, { status: 404 });
  });

  it("424s when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    for (const url of ["/api/recipes", "/api/recipes/Bolo", "/api/recipes/Bolo/image"]) {
      expect((await app.inject({ method: "GET", url, headers: auth })).statusCode).toBe(424);
    }
  });

  it("lists recipes from the Cookbook folder, detail flattens instructions", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: recipesFake });
    connect(store, secrets);
    const list = await app.inject({ method: "GET", url: "/api/recipes", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().recipes).toEqual([
      expect.objectContaining({
        id: "Bolo",
        name: "Bolo",
        hasImage: true,
        keywords: ["cake", "dessert"],
      }),
      expect.objectContaining({ id: "Pasta", name: "Pasta", hasImage: false }),
    ]);
    const detail = await app.inject({ method: "GET", url: "/api/recipes/Bolo", headers: auth });
    expect(detail.json().recipe).toMatchObject({
      name: "Bolo",
      servings: "8",
      totalTime: "PT1H10M",
      ingredients: ["200g flour", "3 eggs"],
      instructions: ["Mix.", "Bake.", "Cool."],
    });
  });

  it("proxies the recipe image and 404s unknown ids", async () => {
    const { app, auth, store, secrets } = await testApp({ fetchImpl: recipesFake });
    connect(store, secrets);
    const img = await app.inject({ method: "GET", url: "/api/recipes/Bolo/image", headers: auth });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toContain("image/jpeg");
    expect(img.body).toBe("jpeg-bytes");
    expect(
      (await app.inject({ method: "GET", url: "/api/recipes/Nope", headers: auth })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/recipes/..%2Fsecret",
          headers: auth,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("answers an empty list when the recipes folder does not exist", async () => {
    const { app, auth, store, secrets } = await testApp({
      fetchImpl: fakeFetch(() => new Response("missing", { status: 404 })),
    });
    connect(store, secrets);
    const res = await app.inject({ method: "GET", url: "/api/recipes", headers: auth });
    expect(res.json()).toEqual({ recipes: [] });
  });
});

describe("module framework", () => {
  it("GET /api/modules lists enabled modules and their service deps", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/modules", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      modules: [
        { id: "einhub", requires: [] },
        { id: "tables", requires: ["nextcloud"] },
        { id: "monitor", requires: ["nextcloud"] },
        { id: "wiki", requires: ["nextcloud"] },
        { id: "csv-manager", requires: [] },
        { id: "einchat", requires: [] },
        { id: "yamtrack", requires: [] },
        { id: "audiobookshelf", requires: [] },
        { id: "navidrome", requires: [] },
        { id: "einmusic", requires: [] },
        { id: "trek", requires: [] },
        { id: "email", requires: [] },
        { id: "gotify", requires: [] },
        { id: "gitlab", requires: [] },
        { id: "github", requires: [] },
        { id: "authentik", requires: [] },
        { id: "nextcloud", requires: ["nextcloud"] },
        { id: "settings", requires: [] },
        { id: "passman", requires: ["nextcloud"] },
        { id: "talk", requires: ["nextcloud"] },
        { id: "matrix", requires: [] },
        { id: "eindav", requires: ["nextcloud"] },
        { id: "recipes", requires: ["nextcloud"] },
        { id: "school", requires: [] },
      ],
    });
  });

  it("MODULES disables unlisted modules' routes and registry entries", async () => {
    const { app, auth } = await testApp({ config: loadConfig({ ...testEnv(), MODULES: "" }) });
    expect(
      (await app.inject({ method: "GET", url: "/api/tables", headers: auth })).statusCode,
    ).toBe(404);
    const mods = await app.inject({ method: "GET", url: "/api/modules", headers: auth });
    expect(mods.json()).toEqual({ modules: [] });
  });

  it("fails startup when an enabled module's env config is invalid", async () => {
    await expect(
      testApp({
        config: loadConfig({ ...testEnv(), MODULE_TABLES_APPLICATION_ID: "abc" }),
      }),
    ).rejects.toThrow(/Invalid config for module "tables"/);
  });

  it("boots with an empty MODULE_TABLES_APPLICATION_ID and reports not-configured", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_TABLES_APPLICATION_ID: "" }),
    });
    const res = await app.inject({ method: "GET", url: "/api/tables", headers: auth });
    expect(res.statusCode).toBe(424);
    expect(res.json().error).toMatch(/not configured/);
  });

  it("ignores invalid module env when the module is disabled", async () => {
    const env = testEnv();
    delete env.MODULE_TABLES_APPLICATION_ID;
    const { app, auth } = await testApp({ config: loadConfig({ ...env, MODULES: "" }) });
    const res = await app.inject({ method: "GET", url: "/api/modules", headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it("unknown MODULES entries fail fast", async () => {
    await expect(
      testApp({ config: loadConfig({ ...testEnv(), MODULES: "tables,nope" }) }),
    ).rejects.toThrow(/Unknown modules in MODULES: nope/);
  });
});
