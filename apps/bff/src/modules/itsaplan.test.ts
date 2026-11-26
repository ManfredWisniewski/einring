import { describe, expect, it } from "vitest";
import type { AppContext } from "../app.js";
import { fakeFetch, json, testApp } from "../test-utils.js";
import { itsaplanModule } from "./itsaplan.js";

const API = "https://plan.w1t.org/api";

const BOARDS = [
  {
    id: 1,
    teamRef: "wit",
    key: "CLV",
    ref: "wit.CLV",
    name: "Client Work",
    teamName: "WIT",
    archivedAt: null,
    lastActivityAt: "2026-11-25T10:00:00Z",
  },
  {
    id: 2,
    teamRef: "wit",
    key: "OPS",
    ref: "wit.OPS",
    name: "Operations",
    teamName: "WIT",
    archivedAt: "2026-11-01T00:00:00Z",
    lastActivityAt: null,
  },
];

const ISSUES = [
  {
    id: 11,
    identifier: "CLV-3",
    title: "Write spec",
    columnId: 100,
    priority: "high",
    dueDate: "2026-11-30",
    updatedAt: "2026-11-25T09:00:00Z",
    projectId: 1,
    projectRef: "wit.CLV",
    projectKey: "CLV",
    projectName: "Client Work",
    teamName: "WIT",
  },
  {
    id: 12,
    identifier: "OPS-7",
    title: "Rotate keys",
    columnId: 200,
    priority: null,
    dueDate: null,
    updatedAt: "2026-11-24T08:00:00Z",
    projectId: 2,
    projectRef: "wit.OPS",
    projectKey: "OPS",
    projectName: "Operations",
    teamName: "WIT",
  },
];

const COLUMNS: Record<string, { id: number; name: string; stateType: string }[]> = {
  "wit.CLV": [{ id: 100, name: "In Progress", stateType: "started" }],
  "wit.OPS": [{ id: 200, name: "Todo", stateType: "unstarted" }],
};

function upstream(opts: { authed?: boolean; issuesStatus?: number } = {}) {
  const calls: { url: string; key?: string }[] = [];
  const handler = fakeFetch((url, init) => {
    calls.push({ url, key: (init?.headers as Record<string, string>)?.["x-api-key"] });
    if (url.endsWith(`${API}/me`)) {
      return json(
        opts.authed === false
          ? { authenticated: false }
          : { authenticated: true, user: { id: "u-1" } },
      );
    }
    if (url.endsWith(`${API}/projects`)) return json(BOARDS);
    if (url.includes(`${API}/issues`)) return json(ISSUES, opts.issuesStatus ?? 200);
    for (const [ref, columns] of Object.entries(COLUMNS)) {
      if (url.endsWith(`${API}/projects/${ref}`)) return json({ columns });
    }
    return json({ error: `unexpected ${url}` }, 500);
  });
  return Object.assign(handler, { calls });
}

async function connectedApp(fetch = upstream()) {
  const { app, store, auth, config, secrets } = await testApp({ fetchImpl: fetch });
  const res = await app.inject({
    method: "POST",
    url: "/api/itsaplan/credentials",
    headers: { ...auth, "content-type": "application/json" },
    payload: { apiKey: "key-1", url: "https://plan.w1t.org" },
  });
  return { app, store, auth, config, secrets, res };
}

describe("itsaplan module", () => {
  it("reports disconnected and answers list routes with 424 (SC-001)", async () => {
    const { app, auth } = await testApp({ fetchImpl: upstream() });
    const status = await app.inject({ url: "/api/itsaplan/status", headers: auth });
    expect(status.json().connected).toBe(false);
    for (const path of ["/api/itsaplan/boards", "/api/itsaplan/tickets"]) {
      const res = await app.inject({ url: path, headers: auth });
      expect(res.statusCode).toBe(424);
    }
  });

  it("normalizes a bare host to the /api base and seals a verified key (SC-001)", async () => {
    const { store, res } = await connectedApp();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: true, url: API });
    const cred = store.getServiceCredential("user-1", "itsaplan");
    expect(cred?.url).toBe(API);
  });

  it("rejects an invalid key with 401 and stores nothing (SC-001, SC-004)", async () => {
    const { app, store, auth } = await testApp({ fetchImpl: upstream({ authed: false }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/itsaplan/credentials",
      headers: { ...auth, "content-type": "application/json" },
      payload: { apiKey: "bad-key", url: API },
    });
    expect(res.statusCode).toBe(401);
    expect(store.getServiceCredential("user-1", "itsaplan")).toBeUndefined();
  });

  it("drops the stored key on disconnect (SC-001)", async () => {
    const { app, store, auth } = await connectedApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/itsaplan/credentials",
      headers: auth,
    });
    expect(res.json()).toEqual({ connected: false });
    expect(store.getServiceCredential("user-1", "itsaplan")).toBeUndefined();
  });

  it("lists member boards with team and web urls, sending x-api-key (SC-002, FR-005)", async () => {
    const fetch = upstream();
    const { app, auth } = await connectedApp(fetch);
    const res = await app.inject({ url: "/api/itsaplan/boards", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().boards).toEqual([
      {
        id: 1,
        key: "CLV",
        ref: "wit.CLV",
        name: "Client Work",
        teamName: "WIT",
        teamRef: "wit",
        url: "https://plan.w1t.org/wit/CLV/",
        archived: false,
        lastActivityAt: "2026-11-25T10:00:00Z",
      },
      {
        id: 2,
        key: "OPS",
        ref: "wit.OPS",
        name: "Operations",
        teamName: "WIT",
        teamRef: "wit",
        url: "https://plan.w1t.org/wit/OPS/",
        archived: true,
        lastActivityAt: null,
      },
    ]);
    const projectsCall = fetch.calls.find((c) => c.url.endsWith(`${API}/projects`));
    expect(projectsCall?.key).toBe("key-1");
  });

  it("lists assigned open tickets with board and column resolved (SC-003)", async () => {
    const fetch = upstream();
    const { app, auth } = await connectedApp(fetch);
    const res = await app.inject({ url: "/api/itsaplan/tickets", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().tickets).toHaveLength(2);
    const [spec, keys] = res.json().tickets;
    expect(spec).toMatchObject({
      id: 11,
      identifier: "CLV-3",
      title: "Write spec",
      projectRef: "wit.CLV",
      projectName: "Client Work",
      teamName: "WIT",
      column: "In Progress",
      stateType: "started",
      priority: "high",
      dueDate: "2026-11-30",
      url: "https://plan.w1t.org/wit/issue/CLV-3",
    });
    expect(keys).toMatchObject({ column: "Todo", stateType: "unstarted" });
    const issuesCall = fetch.calls.find((c) => c.url.includes(`${API}/issues`));
    expect(issuesCall?.url).toContain("assigneeUserId=u-1");
    expect(issuesCall?.url).toContain("stateTypes=backlog,unstarted,started");
  });

  it("maps an unreachable instance to 502 (SC-004)", async () => {
    const { app, auth } = await testApp({ fetchImpl: upstream({ issuesStatus: 503 }) });
    await app.inject({
      method: "POST",
      url: "/api/itsaplan/credentials",
      headers: { ...auth, "content-type": "application/json" },
      payload: { apiKey: "key-1", url: API },
    });
    const res = await app.inject({ url: "/api/itsaplan/tickets", headers: auth });
    expect(res.statusCode).toBe(502);
  });

  it("feeds assigned tickets to EinHub as notification items (FR-009)", async () => {
    const { store, config, secrets } = await connectedApp();
    const ctx = {
      config,
      store,
      secrets,
      fetchImpl: upstream(),
    } as unknown as AppContext;
    const items = await itsaplanModule.notifications?.(ctx, {}).poll("user-1");
    expect(items).toEqual([
      {
        sourceId: "11",
        title: "CLV-3: Write spec",
        body: "Client Work · WIT",
        at: "2026-11-25T09:00:00Z",
      },
      {
        sourceId: "12",
        title: "OPS-7: Rotate keys",
        body: "Operations · WIT",
        at: "2026-11-24T08:00:00Z",
      },
    ]);
  });

  it("answers EinChat tools or not_connected (FR-010)", async () => {
    const { store, config, secrets } = await connectedApp();
    const ctx = {
      config,
      store,
      secrets,
      fetchImpl: upstream(),
    } as unknown as AppContext;
    const tools = itsaplanModule.chatTools?.(ctx, {}) ?? [];
    const boards = await tools.find((t) => t.name === "itsaplan_boards")?.call({}, "user-1");
    expect(boards).toMatchObject({ boards: [{ ref: "wit.CLV" }, { ref: "wit.OPS" }] });
    const tickets = await tools
      .find((t) => t.name === "itsaplan_tickets")
      ?.call({ limit: 5 }, "user-1");
    expect(tickets).toMatchObject({ tickets: [{ identifier: "CLV-3" }, { identifier: "OPS-7" }] });
    const unconnected = await tools.find((t) => t.name === "itsaplan_boards")?.call({}, "other");
    expect(unconnected).toEqual({ error: "not_connected" });
  });
});
