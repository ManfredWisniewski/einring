import { describe, expect, it } from "vitest";
import type { AppContext } from "../../app.js";
import { fakeFetch, json, TEST_USER, testApp } from "../../test-utils.js";
import { eintimeModule } from "../eintime.js";
import { segmentEntry } from "./segment.js";

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
    lastActivityAt: null,
    timeEstimateEnabled: true,
  },
];

const ISSUES = [
  {
    id: 11,
    identifier: "CLV-3",
    title: "Write spec",
    columnId: 100,
    priority: "high",
    dueDate: null,
    updatedAt: "2026-11-25T09:00:00Z",
    estimateMinutes: 130,
    projectId: 1,
    projectRef: "wit.CLV",
    projectKey: "CLV",
    projectName: "Client Work",
    teamName: "WIT",
  },
];

function upstream() {
  return fakeFetch((url) => {
    if (url.endsWith(`${API}/me`)) {
      return json({ authenticated: true, user: { id: "u-1" } });
    }
    if (url.endsWith(`${API}/projects`)) return json(BOARDS);
    if (url.includes(`${API}/issues`)) return json(ISSUES);
    if (url.includes(`${API}/projects/`)) return json({ columns: [] });
    return json({ error: `unexpected ${url}` }, 500);
  });
}

async function connectedApp() {
  const t = await testApp({ fetchImpl: upstream() });
  await t.app.inject({
    method: "POST",
    url: "/api/itsaplan/credentials",
    headers: { ...t.auth, "content-type": "application/json" },
    payload: { apiKey: "key-1", url: "https://plan.w1t.org" },
  });
  return t;
}

type TApp = Awaited<ReturnType<typeof testApp>>;
const post = (
  app: TApp["app"],
  url: string,
  auth: TApp["auth"],
  payload?: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url,
    headers: payload ? { ...auth, "content-type": "application/json" } : auth,
    payload,
  });

describe("eintime module (spec eintime)", () => {
  it("runs one timer per user: start, patch, second start stops the first, stop (SC-001)", async () => {
    const { app, auth } = await testApp();
    expect(
      (await app.inject({ url: "/api/eintime/timer", headers: auth })).json().running,
    ).toBeNull();

    const start = await post(app, "/api/eintime/timer", auth, { description: "deep work" });
    expect(start.statusCode).toBe(200);
    const first = start.json().running;
    expect(first.running).toBe(true);
    expect(first.end).toBeNull();

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/eintime/timer",
      headers: { ...auth, "content-type": "application/json" },
      payload: { description: "renamed", billable: true, tags: ["focus"] },
    });
    expect(patch.json().running.description).toBe("renamed");
    expect(patch.json().running.billable).toBe(true);
    expect(patch.json().running.tags).toEqual(["focus"]);
    expect(patch.json().running.end).toBeNull();

    const second = await post(app, "/api/eintime/timer", auth, {});
    expect(second.json().running.id).not.toBe(first.id);
    const after = await app.inject({ url: "/api/eintime/timer", headers: auth });
    expect(after.json().running.id).toBe(second.json().running.id);

    const stop = await post(app, "/api/eintime/timer/stop", auth, {});
    expect(stop.json().entry.end).not.toBeNull();
    expect(
      (await app.inject({ url: "/api/eintime/timer", headers: auth })).json().running,
    ).toBeNull();
    expect((await post(app, "/api/eintime/timer/stop", auth)).statusCode).toBe(404);
  });

  it("creates, patches and deletes manual entries; bad ranges are rejected (SC-001)", async () => {
    const { app, auth } = await testApp();
    const bad = await post(app, "/api/eintime/entries", auth, {
      start: "2026-11-25T10:00:00Z",
      end: "2026-11-25T09:00:00Z",
    });
    expect(bad.statusCode).toBe(400);

    const created = await post(app, "/api/eintime/entries", auth, {
      start: "2026-11-25T10:00:00Z",
      durationMinutes: 90,
      description: "spec work",
      tags: ["planning"],
    });
    expect(created.statusCode).toBe(201);
    const entry = created.json().entry;
    expect(entry.end).toBe("2026-11-25T11:30:00.000Z");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/eintime/entries/${entry.id}`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { end: "2026-11-25T12:00:00Z", billable: true },
    });
    expect(patched.json().entry.end).toBe("2026-11-25T12:00:00Z");
    expect(patched.json().entry.billable).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/eintime/entries/${entry.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ url: `/api/eintime/entries/${entry.id}`, headers: auth })).statusCode,
    ).toBe(404);
  });

  it("splits cross-midnight entries into per-day segments (SC-003)", async () => {
    const { app, auth } = await testApp();
    await post(app, "/api/eintime/entries", auth, {
      start: "2026-11-25T23:00:00Z",
      end: "2026-11-26T01:00:00Z",
    });
    const res = await app.inject({
      url: "/api/eintime/entries?from=2026-11-25T00:00:00Z&to=2026-11-27T00:00:00Z&tzOffset=0",
      headers: auth,
    });
    const segs = res.json().entries;
    expect(segs).toHaveLength(2);
    expect(segs.map((s: { day: string }) => s.day).sort()).toEqual(["2026-11-25", "2026-11-26"]);
    const day25 = segs.find((s: { day: string }) => s.day === "2026-11-25");
    expect(day25.segStart).toBe("2026-11-25T23:00:00.000Z");
    expect(day25.segEnd).toBe("2026-11-26T00:00:00.000Z");
  });

  it("segments respect the local tz offset (SC-003)", () => {
    // Berlin (UTC+1 → getTimezoneOffset -60): 23:30Z is 00:30 local on the 26th.
    const segs = segmentEntry(
      { id: "e", start: "2026-11-25T23:30:00Z", end: "2026-11-26T00:30:00Z" },
      new Date("2026-11-26T00:30:00Z"),
      -60,
    );
    expect(segs.map((s) => s.day)).toEqual(["2026-11-26"]);
    const utcSegs = segmentEntry(
      { id: "e", start: "2026-11-25T23:30:00Z", end: "2026-11-26T00:30:00Z" },
      new Date("2026-11-26T00:30:00Z"),
      0,
    );
    expect(utcSegs.map((s) => s.day).sort()).toEqual(["2026-11-25", "2026-11-26"]);
  });

  it("serves projects through the mapping layer and degrades empty when unconnected (SC-007)", async () => {
    const { app, auth } = await connectedApp();
    const res = await app.inject({ url: "/api/eintime/projects", headers: auth });
    const body = res.json();
    expect(body.providers).toEqual(["itsaplan"]);
    expect(body.clients).toEqual([{ provider: "itsaplan", externalId: "wit", name: "WIT" }]);
    expect(body.projects).toEqual([
      { provider: "itsaplan", externalId: "wit.CLV", clientExternalId: "wit", name: "Client Work" },
    ]);
    expect(body.tasks).toEqual([
      {
        provider: "itsaplan",
        externalId: "11",
        projectExternalId: "wit.CLV",
        name: "CLV-3: Write spec",
        url: "https://plan.w1t.org/wit/issue/CLV-3",
      },
    ]);

    const bare = await testApp();
    const empty = await bare.app.inject({ url: "/api/eintime/projects", headers: bare.auth });
    expect(empty.json()).toEqual({ providers: ["itsaplan"], clients: [], projects: [], tasks: [] });
  });

  it("reports grouped totals and filtered entry rows (SC-006)", async () => {
    const { app, auth } = await testApp();
    const mk = (payload: Record<string, unknown>) =>
      post(app, "/api/eintime/entries", auth, payload);
    await mk({
      start: "2026-11-24T10:00:00Z",
      durationMinutes: 60,
      clientName: "WIT",
      projectName: "Client Work",
      taskName: "CLV-3: Write spec",
      provider: "itsaplan",
      projectExternalId: "wit.CLV",
      taskExternalId: "11",
      billable: true,
      tags: ["planning"],
    });
    await mk({
      start: "2026-11-24T12:00:00Z",
      durationMinutes: 30,
      clientName: "WIT",
      projectName: "Operations",
      provider: "itsaplan",
      projectExternalId: "wit.OPS",
    });
    await mk({ start: "2026-11-24T13:00:00Z", durationMinutes: 45 });

    const report = (
      await app.inject({
        url: "/api/eintime/report?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z&groupBy=client",
        headers: auth,
      })
    ).json();
    expect(report.groupBy).toBe("client");
    expect(report.member.sub).toBe(TEST_USER.sub);
    const wit = report.groups.find((g: { key: string }) => g.key === "WIT");
    expect(wit.minutes).toBe(90);
    expect(wit.entryCount).toBe(2);
    expect(report.totalMinutes).toBe(135);
    expect(report.entries).toHaveLength(3);
    expect(report.entries[0]).toHaveProperty("member", TEST_USER.sub);

    const filtered = (
      await app.inject({
        url: "/api/eintime/report?from=2026-11-24T00:00:00Z&to=2026-11-25T00:00:00Z&groupBy=project&billable=true",
        headers: auth,
      })
    ).json();
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.groups[0].key).toBe("wit.CLV");
  });

  it("keeps all data scoped per sub (NFR-001)", async () => {
    const { app, auth, store } = await testApp();
    store.createTimeEntry({
      id: "foreign",
      sub: "other-user",
      start: "2026-11-24T10:00:00Z",
      end: "2026-11-24T11:00:00Z",
      description: "not yours",
      provider: null,
      projectExternalId: null,
      taskExternalId: null,
      clientName: null,
      projectName: null,
      taskName: null,
      billable: 0,
      origin: "manual",
    });
    const list = (await app.inject({ url: "/api/eintime/entries", headers: auth })).json().entries;
    expect(list).toHaveLength(0);
    const report = (await app.inject({ url: "/api/eintime/report", headers: auth })).json();
    expect(report.entries).toHaveLength(0);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/eintime/entries/foreign",
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("exposes the chat tools with caller-scoped data (SC-009)", async () => {
    const { store } = await testApp();
    store.createTimeEntry({
      id: "mine",
      sub: TEST_USER.sub,
      start: "2026-11-24T10:00:00Z",
      end: "2026-11-24T11:00:00Z",
      description: "chat visible",
      provider: null,
      projectExternalId: null,
      taskExternalId: null,
      clientName: null,
      projectName: null,
      taskName: null,
      billable: 0,
      origin: "manual",
    });
    const ctx = { store, fetchImpl: upstream() } as unknown as AppContext;
    const tools = eintimeModule.chatTools?.(ctx, { SNAP_MINUTES: 15 }) ?? [];
    const tool = (name: string) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`tool ${name} missing`);
      return t;
    };

    const entries = (await tool("eintime_entries").call({}, TEST_USER.sub, TEST_USER)) as {
      entries: { id: string }[];
    };
    expect(entries.entries.map((e) => e.id)).toEqual(["mine"]);

    const report = (await tool("eintime_report").call(
      { groupBy: "task" },
      TEST_USER.sub,
      TEST_USER,
    )) as { entries: unknown[]; totalMinutes: number };
    expect(report.totalMinutes).toBe(60);

    const empty = (await tool("eintime_entries").call({}, "nobody", TEST_USER)) as {
      entries: unknown[];
    };
    expect(empty.entries).toEqual([]);

    const projects = (await tool("eintime_projects").call({}, TEST_USER.sub, TEST_USER)) as {
      providers: string[];
      clients: unknown[];
    };
    expect(projects.providers).toEqual(["itsaplan"]);
    expect(projects.clients).toEqual([]);
  });
});
