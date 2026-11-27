import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { TEST_USER, testApp, testEnv } from "../../test-utils.js";

type TApp = Awaited<ReturnType<typeof testApp>>;

const jsonHeaders = (auth: TApp["auth"]) => ({ ...auth, "content-type": "application/json" });
const post = (app: TApp["app"], url: string, auth: TApp["auth"], payload?: object) =>
  app.inject({ method: "POST", url, headers: jsonHeaders(auth), payload });
const put = (app: TApp["app"], url: string, auth: TApp["auth"], payload?: object) =>
  app.inject({ method: "PUT", url, headers: jsonHeaders(auth), payload });
const patch = (app: TApp["app"], url: string, auth: TApp["auth"], payload?: object) =>
  app.inject({ method: "PATCH", url, headers: jsonHeaders(auth), payload });
const del = (app: TApp["app"], url: string, auth: TApp["auth"]) =>
  app.inject({ method: "DELETE", url, headers: auth });
const get = (app: TApp["app"], url: string, auth: TApp["auth"]) =>
  app.inject({ method: "GET", url, headers: auth });

const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function createMedication(
  app: TApp["app"],
  auth: TApp["auth"],
  input: Record<string, unknown> = {},
) {
  const res = await post(app, "/api/einpill/medications", auth, {
    name: "Testpill",
    pillsPerPackage: 10,
    dailyUsage: 1,
    ...input,
  });
  expect(res.statusCode).toBe(201);
  return res.json().medication;
}

describe("einpill module (spec einpill)", () => {
  it("creates, validates, edits, archives, reactivates and deletes medications (SC-001)", async () => {
    const { app, auth } = await testApp();
    expect((await post(app, "/api/einpill/medications", auth, { name: "" })).statusCode).toBe(400);
    expect(
      (
        await post(app, "/api/einpill/medications", auth, {
          name: "Bad",
          pillsPerPackage: 0,
          dailyUsage: 1,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(app, "/api/einpill/medications", auth, {
          name: "Bad",
          pillsPerPackage: 10,
          dailyUsage: 1.0001,
        })
      ).statusCode,
    ).toBe(400);
    for (const input of [
      { name: "x".repeat(121), pillsPerPackage: 10, dailyUsage: 1 },
      { name: "Bad", pillsPerPackage: -1, dailyUsage: 1 },
      { name: "Bad", pillsPerPackage: 10_001, dailyUsage: 1 },
      { name: "Bad", pillsPerPackage: 1.5, dailyUsage: 1 },
      { name: "Bad", pillsPerPackage: "10", dailyUsage: 1 },
      { name: "Bad", pillsPerPackage: 10, dailyUsage: -1 },
      { name: "Bad", pillsPerPackage: 10, dailyUsage: 101 },
      { name: "Bad", pillsPerPackage: 10, dailyUsage: "1" },
    ]) {
      expect((await post(app, "/api/einpill/medications", auth, input)).statusCode).toBe(400);
    }

    const med = await createMedication(app, auth, { name: "  Ringoxid  " });
    expect(med.name).toBe("Ringoxid");
    expect(med.archived).toBe(false);
    expect(med.revisions).toHaveLength(1);
    expect(med.projection.state).toBe("untracked");

    const renamed = await patch(app, `/api/einpill/medications/${med.id}`, auth, {
      name: "Ringoxid forte",
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().medication.name).toBe("Ringoxid forte");

    const archived = await patch(app, `/api/einpill/medications/${med.id}`, auth, {
      archived: true,
    });
    expect(archived.json().medication.archived).toBe(true);
    expect((await get(app, "/api/einpill/medications", auth)).json().medications).toHaveLength(0);
    expect(
      (await get(app, "/api/einpill/medications?includeArchived=1", auth)).json().medications,
    ).toHaveLength(1);

    await patch(app, `/api/einpill/medications/${med.id}`, auth, { archived: false });
    expect((await get(app, "/api/einpill/medications", auth)).json().medications).toHaveLength(1);
    expect((await del(app, `/api/einpill/medications/${med.id}`, auth)).statusCode).toBe(204);
    expect((await get(app, "/api/einpill/medications", auth)).json().medications).toHaveLength(0);
  });

  it("scopes every medication and package route to the caller (SC-001, NFR-001)", async () => {
    const { app, auth } = await testApp({
      verifyToken: async (token) => (token === "other-token" ? { sub: "other-user" } : TEST_USER),
    });
    const other = { authorization: "Bearer other-token" };
    const med = await createMedication(app, auth);
    const pkg = await post(app, `/api/einpill/medications/${med.id}/packages`, auth, {
      addedDate: day(0),
    });
    const pkgId = pkg.json().medication.packages[0].id;

    expect(
      (await patch(app, `/api/einpill/medications/${med.id}`, other, { name: "x" })).statusCode,
    ).toBe(404);
    expect((await del(app, `/api/einpill/medications/${med.id}`, other)).statusCode).toBe(404);
    expect(
      (await patch(app, `/api/einpill/packages/${pkgId}`, other, { addedDate: day(0) })).statusCode,
    ).toBe(404);
    expect((await del(app, `/api/einpill/packages/${pkgId}`, other)).statusCode).toBe(404);
    expect((await get(app, "/api/einpill/medications", other)).json().medications).toHaveLength(0);
    expect((await get(app, "/api/einpill/medications", { authorization: "" })).statusCode).toBe(
      401,
    );
  });

  it("upserts same-date revisions and accepts past, current and future effective dates (SC-002)", async () => {
    const { app, auth } = await testApp();
    const med = await createMedication(app, auth, { effectiveDate: day(0), dailyUsage: 1 });
    const overwritten = await put(app, `/api/einpill/medications/${med.id}/revision`, auth, {
      effectiveDate: day(0),
      pillsPerPackage: 20,
      dailyUsage: 0.5,
    });
    expect(overwritten.statusCode).toBe(200);
    expect(overwritten.json().medication.revisions).toHaveLength(1);
    expect(overwritten.json().medication.pillsPerPackage).toBe(20);
    expect(overwritten.json().medication.dailyUsage).toBe(0.5);

    for (const effectiveDate of [day(-10), day(10)]) {
      const res = await put(app, `/api/einpill/medications/${med.id}/revision`, auth, {
        effectiveDate,
        pillsPerPackage: 30,
        dailyUsage: 1.5,
      });
      expect(res.statusCode).toBe(200);
    }
    const listed = (await get(app, "/api/einpill/medications", auth)).json().medications[0];
    expect(listed.revisions).toHaveLength(3);
    expect(listed.revisions.map((r: { effectiveDate: string }) => r.effectiveDate)).toEqual([
      day(-10),
      day(0),
      day(10),
    ]);
  });

  it("adds, edits and deletes packages and returns the server projection (SC-002)", async () => {
    const { app, auth } = await testApp();
    const med = await createMedication(app, auth, {
      pillsPerPackage: 10,
      dailyUsage: 1,
      effectiveDate: day(-1),
    });
    expect(
      (await post(app, `/api/einpill/medications/${med.id}/packages`, auth, { addedDate: day(1) }))
        .statusCode,
    ).toBe(400);

    const added = await post(app, `/api/einpill/medications/${med.id}/packages`, auth, {
      addedDate: day(0),
    });
    expect(added.statusCode).toBe(201);
    const withPackage = added.json().medication;
    expect(withPackage.projection).toMatchObject({
      state: "active",
      currentRemainingPills: 10,
      totalRemainingPills: 10,
      remainingDays: 10,
      runoutDate: day(10),
    });

    const pkgId = withPackage.packages[0].id;
    const edited = await patch(app, `/api/einpill/packages/${pkgId}`, auth, { addedDate: day(-1) });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().medication.projection.currentRemainingPills).toBe(9);
    expect((await del(app, `/api/einpill/packages/${pkgId}`, auth)).statusCode).toBe(204);
    const empty = (await get(app, "/api/einpill/medications", auth)).json().medications[0];
    expect(empty.projection.state).toBe("untracked");
  });

  it("contributes threshold warnings to einhub with structured i18n and dedupe (SC-004, SC-007)", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" }),
    });
    const med = await createMedication(app, auth, {
      pillsPerPackage: 10,
      dailyUsage: 1,
      effectiveDate: day(0),
    });
    await post(app, `/api/einpill/medications/${med.id}/packages`, auth, { addedDate: day(0) });

    const first = await get(app, "/api/einhub/notifications", auth);
    expect(first.statusCode).toBe(200);
    const items = first
      .json()
      .notifications.filter((n: { module: string }) => n.module === "einpill");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Testpill runs out soon",
      read: false,
      i18n: {
        titleKey: "modules.einpill.notificationRestockTitle",
        bodyKey: "modules.einpill.notificationRestockBody",
      },
    });
    expect(first.json().unread).toBeGreaterThanOrEqual(1);

    const second = await get(app, "/api/einhub/notifications", auth);
    expect(
      second.json().notifications.filter((n: { module: string }) => n.module === "einpill"),
    ).toHaveLength(1);
  });

  it("does not warn above the threshold, before the first package or for archived meds; exhausted stock warns (SC-004)", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULE_EINHUB_REFRESH_SECONDS: "0" }),
    });
    const quiet = await createMedication(app, auth, {
      name: "Quiet",
      pillsPerPackage: 20,
      dailyUsage: 1,
    });
    await post(app, `/api/einpill/medications/${quiet.id}/packages`, auth, { addedDate: day(0) });
    const threshold = await createMedication(app, auth, {
      name: "Threshold",
      pillsPerPackage: 14,
      dailyUsage: 1,
    });
    await post(app, `/api/einpill/medications/${threshold.id}/packages`, auth, {
      addedDate: day(0),
    });
    const aboveThreshold = await createMedication(app, auth, {
      name: "AboveThreshold",
      pillsPerPackage: 15,
      dailyUsage: 1,
    });
    await post(app, `/api/einpill/medications/${aboveThreshold.id}/packages`, auth, {
      addedDate: day(0),
    });
    const untracked = await createMedication(app, auth, { name: "Untracked" });
    expect(untracked.projection.state).toBe("untracked");
    const archived = await createMedication(app, auth, { name: "Archived", pillsPerPackage: 1 });
    await post(app, `/api/einpill/medications/${archived.id}/packages`, auth, {
      addedDate: day(0),
    });
    await patch(app, `/api/einpill/medications/${archived.id}`, auth, { archived: true });

    let feed = await get(app, "/api/einhub/notifications", auth);
    expect(
      feed.json().notifications.filter((n: { module: string }) => n.module === "einpill"),
    ).toHaveLength(1);
    expect(
      feed
        .json()
        .notifications.find((n: { module: string; title: string }) => n.module === "einpill").title,
    ).toBe("Threshold runs out soon");

    const exhausted = await createMedication(app, auth, {
      name: "Exhausted",
      pillsPerPackage: 1,
      dailyUsage: 1,
    });
    await post(app, `/api/einpill/medications/${exhausted.id}/packages`, auth, {
      addedDate: day(-3),
    });
    feed = await get(app, "/api/einhub/notifications", auth);
    const items = feed
      .json()
      .notifications.filter((n: { module: string }) => n.module === "einpill");
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Exhausted is out of stock");
    expect(items[0].i18n.titleKey).toBe("modules.einpill.notificationOutTitle");
    expect(items[0].i18n.bodyKey).toBe("modules.einpill.notificationOutBody");
  });

  it("registers as a standard backend module with a semver version (SC-005)", async () => {
    const { app, auth } = await testApp();
    const modules = (await get(app, "/api/modules", auth)).json().modules;
    expect(modules.find((m: { id: string }) => m.id === "einpill")).toMatchObject({
      version: "0.1.0",
      requires: [],
    });
  });
  it("orders medications by runout urgency with unprojected rows last (SC-003)", async () => {
    const { app, auth } = await testApp();
    const late = await createMedication(app, auth, {
      name: "Late",
      pillsPerPackage: 20,
      dailyUsage: 1,
    });
    const early = await createMedication(app, auth, {
      name: "Early",
      pillsPerPackage: 2,
      dailyUsage: 1,
    });
    await createMedication(app, auth, { name: "Untracked" });
    await post(app, `/api/einpill/medications/${late.id}/packages`, auth, { addedDate: day(0) });
    await post(app, `/api/einpill/medications/${early.id}/packages`, auth, { addedDate: day(0) });

    const medications = (await get(app, "/api/einpill/medications", auth)).json().medications;
    expect(medications.map((m: { name: string }) => m.name)).toEqual([
      "Early",
      "Late",
      "Untracked",
    ]);
  });

  it("is controlled by standard MODULES enablement (SC-005)", async () => {
    const { app, auth } = await testApp({
      config: loadConfig({ ...testEnv(), MODULES: "einhub" }),
    });
    expect((await get(app, "/api/einpill/medications", auth)).statusCode).toBe(404);
    const modules = (await get(app, "/api/modules", auth)).json().modules;
    expect(modules.some((m: { id: string }) => m.id === "einpill")).toBe(false);
  });
});
