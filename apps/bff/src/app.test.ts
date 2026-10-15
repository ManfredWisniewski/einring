import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { Store } from "./db.js";
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

describe("tables", () => {
  it("answers 424 when Nextcloud is not connected", async () => {
    const { app, auth } = await testApp();
    const res = await app.inject({ method: "GET", url: "/api/tables/current", headers: auth });
    expect(res.statusCode).toBe(424);
  });

  it("returns the configured table with flattened rows", async () => {
    const fetchImpl = fakeFetch((url, init) => {
      const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(authHeader).toBe(`Basic ${Buffer.from("frodo:app-pw").toString("base64")}`);
      if (url.endsWith("/api/1/tables/7")) return json({ id: 7, title: "Inventory", emoji: "📦" });
      if (url.endsWith("/api/1/tables/7/columns")) {
        return json([
          {
            id: 2,
            title: "Status",
            type: "selection",
            orderWeight: 1,
            selectionOptions: [{ id: 0, label: "open" }],
          },
          { id: 1, title: "Name", type: "text", subtype: "line", orderWeight: 0 },
        ]);
      }
      if (url.endsWith("/api/1/tables/7/rows")) {
        return json([
          {
            id: 10,
            tableId: 7,
            data: [
              { columnId: 1, value: "Ring" },
              { columnId: 2, value: 0 },
            ],
          },
        ]);
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
    const { app, auth, store, secrets } = await testApp({ fetchImpl });
    store.saveCredential({
      sub: TEST_USER.sub,
      server: "https://cloud.test",
      loginName: "frodo",
      appPasswordSealed: secrets.seal("app-pw"),
    });

    const res = await app.inject({ method: "GET", url: "/api/tables/current", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 7,
      title: "Inventory",
      emoji: "📦",
      columns: [
        { id: 1, title: "Name", type: "text", subtype: "line" },
        { id: 2, title: "Status", type: "selection", subtype: undefined },
      ],
      rows: [{ id: 10, cells: { "1": "Ring", "2": "open" } }],
    });
  });
});

describe("monitor", () => {
  const connect = (store: Store, secrets: SecretBox) =>
    store.saveCredential({
      sub: TEST_USER.sub,
      server: "https://cloud.test",
      loginName: "frodo",
      appPasswordSealed: secrets.seal("app-pw"),
    });
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
    expect(res.json()).toEqual({ available: false, health: null });
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
            frodo: { displayname: "Frodo B.", groups: ["shire", "admin"] },
            sam: { displayname: "Sam", groups: ["shire"] },
            gollum: { displayname: "Gollum", groups: ["elsewhere"] },
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
      groupsAvailable: true,
      groups: ["admin", "elsewhere", "shire"],
      users: [
        {
          userId: "frodo",
          displayName: "Frodo B.",
          status: "online",
          message: "on vacation",
          icon: "🌴",
          groups: ["shire", "admin"],
        },
        {
          userId: "gollum",
          displayName: "Gollum",
          status: "offline",
          message: null,
          icon: null,
          groups: ["elsewhere"],
        },
        {
          userId: "sam",
          displayName: "Sam",
          status: "dnd",
          message: null,
          icon: null,
          groups: ["shire"],
        },
      ],
    });
  });

  it("degrades to groupsAvailable=false without admin rights, resolving names via autocomplete", async () => {
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
      groupsAvailable: false,
      groups: [],
      users: [
        {
          userId: "frodo",
          displayName: "Frodo B.",
          status: "online",
          message: null,
          icon: null,
          groups: [],
        },
      ],
    });
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
      ],
    });
  });

  it("MODULES disables unlisted modules' routes and registry entries", async () => {
    const { app, auth } = await testApp({ config: loadConfig({ ...testEnv(), MODULES: "" }) });
    expect(
      (await app.inject({ method: "GET", url: "/api/tables/current", headers: auth })).statusCode,
    ).toBe(404);
    const mods = await app.inject({ method: "GET", url: "/api/modules", headers: auth });
    expect(mods.json()).toEqual({ modules: [] });
  });

  it("fails startup when an enabled module's env config is invalid", async () => {
    const env = testEnv();
    delete env.MODULE_TABLES_TABLE_ID;
    await expect(testApp({ config: loadConfig(env) })).rejects.toThrow(
      /Invalid config for module "tables"/,
    );
  });

  it("ignores invalid module env when the module is disabled", async () => {
    const env = testEnv();
    delete env.MODULE_TABLES_TABLE_ID;
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
