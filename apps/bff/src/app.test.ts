import { describe, expect, it } from "vitest";
import { fakeFetch, json, TEST_USER, testApp } from "./test-utils.js";

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
