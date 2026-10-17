import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCompositeVerifier, createSessionVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import type { SecretBox } from "./crypto.js";
import { openStore, type Store } from "./db.js";
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
    MODULE_WIKI_LLM_URL: "https://llm.test/v1",
    MODULE_WIKI_LLM_API_KEY: "sk-secret",
    MODULE_WIKI_LLM_CHAT_MODEL: "chat-m",
    MODULE_WIKI_LLM_EMBED_MODEL: "embed-m",
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
      config: loadConfig(llmEnv({ MODULE_WIKI_LLM_TOP_K: "2" })),
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

describe("module framework", () => {
  it("GET /api/modules lists enabled modules and their service deps", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/modules", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      modules: [
        { id: "tables", requires: ["nextcloud"] },
        { id: "monitor", requires: ["nextcloud"] },
        { id: "wiki", requires: ["nextcloud"] },
        { id: "csv-manager", requires: [] },
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
