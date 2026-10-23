import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { AuthUser } from "../auth.js";
import { testApp } from "../test-utils.js";

/* Test identities — pseudonymous only. Roles come from Authentik groups (D56). */
const USERS: Record<string, AuthUser> = {
  "admin-tok": { sub: "admin-1", name: "Ada Admin", groups: ["einring-school-admin"] },
  "teacher-tok": { sub: "teach-1", name: "Tim Teacher", groups: ["einring-school-teacher"] },
  "teacher2-tok": { sub: "teach-2", name: "Tessa Teacher", groups: ["einring-school-teacher"] },
  "parent-tok": { sub: "par-1", name: "Pat Parent", groups: ["einring-school-parent"] },
  "parent2-tok": { sub: "par-2", name: "Pam Parent", groups: ["einring-school-parent"] },
  "student-tok": { sub: "stu-1", name: "Sam Student", groups: ["einring-school-student"] },
  "plain-tok": { sub: "plain-1", name: "No Roles" },
};

const H = (token: string) => ({ authorization: `Bearer ${token}` });
const admin = H("admin-tok");
const teacher = H("teacher-tok");
const parent = H("parent-tok");
const student = H("student-tok");

async function schoolApp(): Promise<FastifyInstance> {
  const { app } = await testApp({
    verifyToken: async (t) => {
      const u = USERS[t];
      if (!u) throw new Error("bad token");
      return u;
    },
  });
  return app;
}

const j = (res: { json: () => unknown }) => res.json() as Record<string, unknown>;

async function mkPerson(app: FastifyInstance, body: Record<string, unknown>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/school/persons",
    headers: admin,
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return j(res).id as string;
}

async function link(app: FastifyInstance, personId: string, sub: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/school/persons/${personId}/link`,
    headers: admin,
    payload: { sub },
  });
  expect(res.statusCode).toBe(200);
}

/** Full fixture: teacher+student+guardian persons, household, lesson type. */
async function fixture(app: FastifyInstance) {
  const teacherId = await mkPerson(app, { kind: "teacher", name: "Tim Teacher" });
  const studentId = await mkPerson(app, {
    kind: "student",
    name: "Sam Student",
    billingMode: "per_lesson",
    lessonCents: 2500,
  });
  const guardianId = await mkPerson(app, { kind: "guardian", name: "Pat Parent" });
  const hh = await app.inject({
    method: "POST",
    url: "/api/school/households",
    headers: admin,
    payload: { name: "Family S" },
  });
  const householdId = j(hh).id as string;
  await app.inject({
    method: "PUT",
    url: `/api/school/households/${householdId}/members`,
    headers: admin,
    payload: {
      members: [
        { personId: guardianId, relation: "guardian" },
        { personId: studentId, relation: "student" },
      ],
    },
  });
  const lt = await app.inject({
    method: "POST",
    url: "/api/school/lesson-types",
    headers: admin,
    payload: { name: "Piano 45", durationMin: 45, defaultRateCents: 2500 },
  });
  const lessonTypeId = j(lt).id as string;
  return { teacherId, studentId, guardianId, householdId, lessonTypeId };
}

describe("school module", () => {
  it("requires authentication", async () => {
    const app = await schoolApp();
    const res = await app.inject({ method: "GET", url: "/api/school/me" });
    expect(res.statusCode).toBe(401);
  });

  it("derives roles from the Authentik groups claim", async () => {
    const app = await schoolApp();
    const res = await app.inject({ method: "GET", url: "/api/school/me", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(j(res).roles).toEqual(["admin"]);

    const res2 = await app.inject({
      method: "GET",
      url: "/api/school/me",
      headers: H("plain-tok"),
    });
    expect(j(res2).roles).toEqual([]);
  });

  it("admin manages persons; parents cannot", async () => {
    const app = await schoolApp();
    const id = await mkPerson(app, { kind: "student", name: "Sam Student" });
    const res = await app.inject({
      method: "GET",
      url: `/api/school/persons/${id}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).person).toMatchObject({ id, name: "Sam Student", kind: "student" });

    const denied = await app.inject({
      method: "POST",
      url: "/api/school/persons",
      headers: parent,
      payload: { kind: "student", name: "Nope" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("scopes guardians to their own household students", async () => {
    const app = await schoolApp();
    const { studentId, guardianId } = await fixture(app);
    const other = await mkPerson(app, { kind: "student", name: "Olga Other" });
    await link(app, guardianId, "par-1");

    const res = await app.inject({ method: "GET", url: "/api/school/persons", headers: parent });
    expect(res.statusCode).toBe(200);
    const ids = (j(res).persons as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(studentId);
    expect(ids).toContain(guardianId);
    expect(ids).not.toContain(other);

    const denied = await app.inject({
      method: "GET",
      url: `/api/school/persons/${other}`,
      headers: parent,
    });
    expect(denied.statusCode).toBe(403);
  });

  it("materializes recurring series, skips holidays", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId } = await fixture(app);
    // Mondays in Jan 2026: 05, 12, 19, 26 (weekday 1 = Monday, getUTCDay)
    const ser = await app.inject({
      method: "POST",
      url: "/api/school/series",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        weekday: 1,
        startTime: "15:00",
        durationMin: 45,
        validFrom: "2026-01-05",
        validUntil: "2026-01-31",
        studentIds: [studentId],
      },
    });
    expect(ser.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/api/school/holidays",
      headers: admin,
      payload: { name: "Break", startDate: "2026-01-12", endDate: "2026-01-12" },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/school/lessons?from=2026-01-01&to=2026-01-31",
      headers: admin,
    });
    const dates = (j(res).lessons as { date: string }[]).map((l) => l.date);
    expect(dates).toEqual(["2026-01-05", "2026-01-19", "2026-01-26"]);
  });

  it("detects teacher and student double-bookings", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId } = await fixture(app);
    const lesson = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        date: "2026-02-02",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    expect(lesson.statusCode).toBe(201);

    const check = await app.inject({
      method: "POST",
      url: "/api/school/lessons/check",
      headers: admin,
      payload: {
        teacherId,
        studentIds: [studentId],
        date: "2026-02-02",
        startTime: "15:15",
        durationMin: 45,
      },
    });
    const kinds = (j(check).conflicts as { kind: string }[]).map((x) => x.kind);
    expect(kinds).toContain("teacher_double_booking");
    expect(kinds).toContain("student_double_booking");

    // second booking without force is rejected
    const clash = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        date: "2026-02-02",
        startTime: "15:15",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    expect(clash.statusCode).toBe(409);
    // admin force-override is allowed
    const forced = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        date: "2026-02-02",
        startTime: "15:15",
        durationMin: 45,
        studentIds: [studentId],
        force: true,
      },
    });
    expect(forced.statusCode).toBe(201);
  });

  it("records attendance and bills attended per-lesson students", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId, householdId } = await fixture(app);
    const lesson = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        date: "2026-03-02",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    const lessonId = j(lesson).id as string;

    const att = await app.inject({
      method: "PUT",
      url: `/api/school/lessons/${lessonId}/attendance`,
      headers: admin,
      payload: { studentId, attendance: "attended", practice: "Scales" },
    });
    expect(att.statusCode).toBe(200);

    const gen = await app.inject({
      method: "POST",
      url: "/api/school/invoices/generate",
      headers: admin,
      payload: { period: "2026-03" },
    });
    expect(j(gen).created).toBe(1);

    const inv = await app.inject({ method: "GET", url: "/api/school/invoices", headers: admin });
    const invoices = j(inv).invoices as { householdId: string; totalCents: number }[];
    expect(invoices).toHaveLength(1);
    expect(invoices.at(0)?.householdId).toBe(householdId);
    expect(invoices.at(0)?.totalCents).toBe(2500);

    // invoice is visible to the linked guardian, invisible to others
    const par = await app.inject({ method: "GET", url: "/api/school/invoices", headers: parent });
    expect((j(par).invoices as unknown[]).length).toBe(0); // par-1 not yet linked
  });

  it("marks invoices paid via payments", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId } = await fixture(app);
    const lesson = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        date: "2026-04-06",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    await app.inject({
      method: "PUT",
      url: `/api/school/lessons/${j(lesson).id}/attendance`,
      headers: admin,
      payload: { studentId, attendance: "attended" },
    });
    await app.inject({
      method: "POST",
      url: "/api/school/invoices/generate",
      headers: admin,
      payload: { period: "2026-04" },
    });
    const inv = await app.inject({ method: "GET", url: "/api/school/invoices", headers: admin });
    const invoice = (j(inv).invoices as { id: string }[]).at(0);
    expect(invoice).toBeDefined();
    const pay = await app.inject({
      method: "POST",
      url: `/api/school/invoices/${invoice?.id}/payments`,
      headers: admin,
      payload: { amountCents: 2500, method: "transfer" },
    });
    expect(pay.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/api/school/invoices/${invoice?.id}`,
      headers: admin,
    });
    expect(j(detail).invoice).toMatchObject({ status: "paid" });
  });

  it("restricts audit log to admins", async () => {
    const app = await schoolApp();
    await fixture(app);
    const ok = await app.inject({ method: "GET", url: "/api/school/audit", headers: admin });
    expect(ok.statusCode).toBe(200);
    expect((j(ok).entries as unknown[]).length).toBeGreaterThan(0);
    const denied = await app.inject({ method: "GET", url: "/api/school/audit", headers: parent });
    expect(denied.statusCode).toBe(403);
  });

  it("lets a linked teacher mark attendance only on own lessons", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId } = await fixture(app);
    const otherTeacher = await mkPerson(app, { kind: "teacher", name: "Tessa Teacher" });
    await link(app, teacherId, "teach-1");
    await link(app, otherTeacher, "teach-2");

    const lesson = await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId: otherTeacher,
        lessonTypeId,
        date: "2026-05-04",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    const lessonId = j(lesson).id as string;
    const denied = await app.inject({
      method: "PUT",
      url: `/api/school/lessons/${lessonId}/attendance`,
      headers: teacher,
      payload: { studentId, attendance: "attended" },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("imports persons from CSV", async () => {
    const app = await schoolApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/school/import/csv",
      headers: admin,
      payload: {
        kind: "persons",
        csv: "kind,name,email\nstudent,Iris Import,iris@test.example\nteacher,Igor Import,igor@test.example\n",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).created).toBe(2);
    const list = await app.inject({
      method: "GET",
      url: "/api/school/persons?search=Import",
      headers: admin,
    });
    expect((j(list).persons as unknown[]).length).toBe(2);
  });

  it("exports a linked person's data (GDPR)", async () => {
    const app = await schoolApp();
    const { studentId, guardianId } = await fixture(app);
    await link(app, guardianId, "par-1");
    const res = await app.inject({
      method: "GET",
      url: `/api/school/persons/${studentId}/export`,
      headers: parent,
    });
    expect(res.statusCode).toBe(200);
    expect(j(res).person).toMatchObject({ id: studentId, name: "Sam Student" });
  });

  it("supports messaging between admin and linked guardian", async () => {
    const app = await schoolApp();
    const { guardianId } = await fixture(app);
    await link(app, guardianId, "par-1");
    const thread = await app.inject({
      method: "POST",
      url: "/api/school/threads",
      headers: admin,
      payload: { title: "Welcome", memberSubs: ["par-1"], body: "Hello family" },
    });
    expect(thread.statusCode).toBe(201);
    const tid = j(thread).id as string;
    const list = await app.inject({ method: "GET", url: "/api/school/threads", headers: parent });
    expect((j(list).threads as { id: string }[]).map((t) => t.id)).toContain(tid);
    const msgs = await app.inject({
      method: "GET",
      url: `/api/school/threads/${tid}/messages`,
      headers: parent,
    });
    expect((j(msgs).messages as { body: string }[]).at(0)?.body).toBe("Hello family");
    // an unrelated parent sees nothing
    const other = await app.inject({
      method: "GET",
      url: `/api/school/threads/${tid}/messages`,
      headers: H("parent2-tok"),
    });
    expect(other.statusCode).toBe(403);
  });

  it("manages events and parent confirmation", async () => {
    const app = await schoolApp();
    const { studentId, guardianId } = await fixture(app);
    await link(app, guardianId, "par-1");
    const ev = await app.inject({
      method: "POST",
      url: "/api/school/events",
      headers: admin,
      payload: { title: "Spring Recital", date: "2026-06-14", startTime: "17:00", kind: "recital" },
    });
    expect(ev.statusCode).toBe(201);
    const eventId = j(ev).id as string;
    await app.inject({
      method: "PUT",
      url: `/api/school/events/${eventId}/participants`,
      headers: admin,
      payload: { participants: [{ studentId, piece: "Menuet" }] },
    });
    const confirm = await app.inject({
      method: "PATCH",
      url: `/api/school/events/${eventId}/participants/${studentId}`,
      headers: parent,
      payload: { status: "confirmed" },
    });
    expect(confirm.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/api/school/events", headers: parent });
    expect((j(list).events as { id: string }[]).map((e) => e.id)).toContain(eventId);
  });

  it("tracks instrument rentals", async () => {
    const app = await schoolApp();
    const { studentId } = await fixture(app);
    const inst = await app.inject({
      method: "POST",
      url: "/api/school/instruments",
      headers: admin,
      payload: { name: "Flöte", monthlyRateCents: 1500 },
    });
    const instId = j(inst).id as string;
    const rent = await app.inject({
      method: "POST",
      url: "/api/school/rentals",
      headers: admin,
      payload: { instrumentId: instId, studentId, startDate: "2026-03-01" },
    });
    expect(rent.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: "/api/school/instruments",
      headers: admin,
    });
    expect((j(list).instruments as { status: string }[]).at(0)?.status).toBe("rented");
  });

  it("student sees only own lessons", async () => {
    const app = await schoolApp();
    const { teacherId, studentId, lessonTypeId } = await fixture(app);
    const other = await mkPerson(app, { kind: "student", name: "Olga Other" });
    await link(app, studentId, "stu-1");
    await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        date: "2026-02-09",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [studentId],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/school/lessons",
      headers: admin,
      payload: {
        teacherId,
        lessonTypeId,
        date: "2026-02-10",
        startTime: "15:00",
        durationMin: 45,
        studentIds: [other],
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/school/lessons?from=2026-02-01&to=2026-02-28",
      headers: student,
    });
    const lessons = j(res).lessons as { students: { studentId: string }[] }[];
    expect(lessons).toHaveLength(1);
    expect(lessons.at(0)?.students.at(0)?.studentId).toBe(studentId);
  });
});
