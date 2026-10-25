import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, LESSON_MAP, type Lesson, mapRow, now, SERIES_MAP, type Series } from "./db.js";
import {
  detectConflicts,
  getSeries,
  guardianStudentIds,
  materializeLessons,
  teacherStudentIds,
  todayBerlin,
  toMin,
  uuid,
  validStudent,
  weekdayOf,
} from "./domain.js";
import {
  type Caller,
  callerOf,
  forbidden,
  isAdmin,
  isStaff,
  needRole,
  ownStudentId,
  ownTeacherId,
  type SchoolConfig,
} from "./scope.js";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^\d{2}:\d{2}$/);

const typeIn = z.object({
  name: z.string().min(1).max(100),
  durationMin: z.number().int().min(5).max(600),
  defaultRateCents: z.number().int().min(0).default(0),
});
const typePatch = typeIn.partial().extend({ active: z.boolean().optional() });

const seriesIn = z.object({
  teacherId: z.string(),
  lessonTypeId: z.string().nullish(),
  weekday: z.number().int().min(0).max(6),
  startTime: timeStr,
  durationMin: z.number().int().min(5).max(600),
  validFrom: dateStr,
  validUntil: dateStr.nullish(),
  location: z.string().max(200).nullish(),
  title: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  studentIds: z.array(z.string()).max(50).default([]),
});
const seriesPatch = seriesIn.partial();

const lessonIn = z.object({
  teacherId: z.string().optional(), // defaults to caller's teacher profile
  lessonTypeId: z.string().nullish(),
  date: dateStr,
  startTime: timeStr,
  durationMin: z.number().int().min(5).max(600),
  location: z.string().max(200).nullish(),
  studentIds: z.array(z.string()).min(1).max(50),
  isMakeup: z.boolean().optional(),
  makeupForLessonId: z.string().nullish(),
  makeupRequestId: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
  force: z.boolean().optional(),
});
const lessonPatch = z.object({
  date: dateStr.optional(),
  startTime: timeStr.optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  location: z.string().max(200).nullish(),
  teacherId: z.string().optional(),
  substituteTeacherId: z.string().nullish(),
  status: z
    .enum(["scheduled", "cancelled_school", "cancelled_teacher", "cancelled_parent"])
    .optional(),
  cancelReason: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
  addStudentIds: z.array(z.string()).max(50).optional(),
  removeStudentIds: z.array(z.string()).max(50).optional(),
  force: z.boolean().optional(),
});

const attendanceIn = z.object({
  studentId: z.string(),
  attendance: z.enum(["attended", "absent_excused", "absent_unexcused", "cancelled"]),
  privateNote: z.string().max(4000).nullish(),
  publicNote: z.string().max(4000).nullish(),
  practice: z.string().max(4000).nullish(),
});

const holidayIn = z.object({
  name: z.string().min(1).max(200),
  startDate: dateStr,
  endDate: dateStr,
  kind: z.enum(["holiday", "closure"]).default("holiday"),
});

const availIn = z.object({
  teacherId: z.string().optional(),
  weekday: z.number().int().min(0).max(6),
  startTime: timeStr,
  endTime: timeStr,
  validFrom: dateStr,
  validUntil: dateStr.nullish(),
});

const absenceIn = z.object({
  teacherId: z.string().optional(),
  startDate: dateStr,
  endDate: dateStr,
  kind: z.enum(["vacation", "sick", "other"]).default("other"),
  note: z.string().max(500).nullish(),
});

const reportAbsenceIn = z.object({
  studentId: z.string(),
  reason: z.string().max(1000).nullish(),
  wantMakeup: z.boolean().optional(),
});

const checkIn = z.object({
  teacherId: z.string(),
  studentIds: z.array(z.string()).max(50).default([]),
  date: dateStr,
  startTime: timeStr,
  durationMin: z.number().int().min(5).max(600),
  excludeLessonId: z.string().optional(),
});

const lessonOut = <T>(l: T) => l;

/** Out-of-scope lessons reduce to an opaque busy slot — no rosters, names or notes. */
const busySlot = (l: Lesson) => ({
  id: l.id,
  date: l.date,
  startTime: l.startTime,
  durationMin: l.durationMin,
  status: l.status,
});

function lessonStudents(db: DatabaseSync, lessonId: string) {
  return db
    .prepare(
      `SELECT ls.student_id AS studentId, ls.attendance, ls.private_note AS privateNote,
                ls.public_note AS publicNote, ls.practice, ls.marked_by_sub AS markedBySub,
                ls.marked_at AS markedAt, p.name AS studentName
         FROM school_lesson_students ls JOIN school_persons p ON p.id = ls.student_id
         WHERE ls.lesson_id = ? ORDER BY p.name`,
    )
    .all(lessonId) as Record<string, unknown>[];
}

/** Lessons the caller is allowed to see. */
function lessonScope(
  c: Caller,
  db: DatabaseSync,
): { teacherId?: string; studentIds?: Set<string> } {
  if (isAdmin(c)) return {};
  const studentIds = new Set<string>();
  const t = ownTeacherId(c);
  if (t) {
    const mine = db
      .prepare(
        `SELECT DISTINCT ls.student_id AS id FROM school_lesson_students ls
         JOIN school_lessons l ON l.id = ls.lesson_id
         WHERE l.teacher_id = ? OR l.substitute_teacher_id = ?`,
      )
      .all(t, t) as { id: string }[];
    for (const r of mine) studentIds.add(r.id);
    return { teacherId: t, studentIds };
  }
  for (const id of guardianStudentIds(db, c.sub)) studentIds.add(id);
  const own = ownStudentId(c);
  if (own) studentIds.add(own);
  return { studentIds };
}

/** May the caller manage this lesson? */
function canManageLesson(c: Caller, l: Lesson): boolean {
  if (isAdmin(c)) return true;
  const t = ownTeacherId(c);
  return t != null && (l.teacherId === t || l.substituteTeacherId === t);
}

export function registerScheduleRoutes(
  api: FastifyInstance,
  db: DatabaseSync,
  cfg: SchoolConfig,
): void {
  const caller = (req: FastifyRequest) => callerOf(db, req, cfg);

  /* --------------------------------------------------------- lesson types */

  api.get("/lesson-types", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c) && !c.roles.includes("parent") && !c.roles.includes("student")) {
      return forbidden(reply);
    }
    return {
      types: db
        .prepare(
          `SELECT id, name, duration_min AS durationMin, default_rate_cents AS defaultRateCents,
                  active FROM school_lesson_types ORDER BY name`,
        )
        .all(),
    };
  });

  api.post("/lesson-types", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = typeIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const id = uuid();
    db.prepare(
      "INSERT INTO school_lesson_types (id, name, duration_min, default_rate_cents) VALUES (?, ?, ?, ?)",
    ).run(id, parsed.data.name, parsed.data.durationMin, parsed.data.defaultRateCents);
    audit(db, c.sub, "create", "lesson_type", id, parsed.data);
    return reply.code(201).send({ id });
  });

  api.patch("/lesson-types/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = typePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      name: p.name,
      duration_min: p.durationMin,
      default_rate_cents: p.defaultRateCents,
      active: p.active === undefined ? undefined : p.active ? 1 : 0,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    const res = db
      .prepare(`UPDATE school_lesson_types SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args, id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "update", "lesson_type", id, p);
    return { ok: true };
  });

  api.delete("/lesson-types/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const res = db.prepare("UPDATE school_lesson_types SET active = 0 WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "deactivate", "lesson_type", id);
    return { ok: true };
  });

  /* ---------------------------------------------------------- lesson series */

  api.get("/series", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT s.*, p.name AS teacherName, lt.name AS typeName
         FROM school_lesson_series s
         JOIN school_persons p ON p.id = s.teacher_id
         LEFT JOIN school_lesson_types lt ON lt.id = s.lesson_type_id
         WHERE s.deleted_at IS NULL ORDER BY s.weekday, s.start_time`,
      )
      .all() as Record<string, unknown>[];
    const own = ownTeacherId(c);
    const items = rows
      .map((r) => ({
        ...mapRow<Series>(r, SERIES_MAP),
        teacherName: r.teacherName,
        typeName: r.typeName,
      }))
      .filter((s) => isAdmin(c) || s.teacherId === own);
    const stud = db.prepare(
      `SELECT ss.student_id AS id, p.name FROM school_series_students ss
       JOIN school_persons p ON p.id = ss.student_id WHERE ss.series_id = ?`,
    );
    return {
      series: items.map((s) => ({ ...s, students: stud.all(s.id) })),
    };
  });

  api.post("/series", async (req, reply) => {
    const c = caller(req);
    const parsed = seriesIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const s = parsed.data;
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || s.teacherId !== own)) return forbidden(reply);
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO school_lesson_series
         (id, teacher_id, lesson_type_id, weekday, start_time, duration_min,
          valid_from, valid_until, location, title, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      s.teacherId,
      s.lessonTypeId ?? null,
      s.weekday,
      s.startTime,
      s.durationMin,
      s.validFrom,
      s.validUntil ?? null,
      s.location ?? null,
      s.title ?? null,
      s.notes ?? null,
      ts,
      ts,
    );
    for (const sid of s.studentIds) {
      if (!validStudent(db, sid)) {
        return reply.code(422).send({ error: `unknown student ${sid}` });
      }
    }
    const ins = db.prepare(
      "INSERT INTO school_series_students (series_id, student_id) VALUES (?, ?)",
    );
    for (const sid of s.studentIds) ins.run(id, sid);
    audit(db, c.sub, "create", "series", id, s);
    return reply.code(201).send({ id });
  });

  api.patch("/series/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const existing = getSeries(db, id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || existing.teacherId !== own)) return forbidden(reply);
    const parsed = seriesPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const s = parsed.data;
    if (!isAdmin(c) && s.teacherId && s.teacherId !== own) return forbidden(reply);
    const fields: Record<string, SQLInputValue | undefined> = {
      teacher_id: s.teacherId,
      lesson_type_id: s.lessonTypeId,
      weekday: s.weekday,
      start_time: s.startTime,
      duration_min: s.durationMin,
      valid_from: s.validFrom,
      valid_until: s.validUntil,
      location: s.location,
      title: s.title,
      notes: s.notes,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      db.prepare(`UPDATE school_lesson_series SET ${sets.join(", ")} WHERE id = ?`).run(
        ...args,
        now(),
        id,
      );
    }
    if (s.studentIds) {
      const before = new Set(
        (
          db
            .prepare("SELECT student_id AS id FROM school_series_students WHERE series_id = ?")
            .all(id) as { id: string }[]
        ).map((r) => r.id),
      );
      const after = new Set(s.studentIds);
      for (const sid of after) {
        if (!validStudent(db, sid)) {
          return reply.code(422).send({ error: `unknown student ${sid}` });
        }
      }
      db.prepare("DELETE FROM school_series_students WHERE series_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO school_series_students (series_id, student_id) VALUES (?, ?)",
      );
      for (const sid of after) ins.run(id, sid);
      // Backfill newly added students into future materialized lessons (D56).
      const today = new Date().toISOString().slice(0, 10);
      const future = db
        .prepare(
          `SELECT id FROM school_lessons
           WHERE series_id = ? AND date >= ? AND status = 'scheduled'`,
        )
        .all(id, today) as { id: string }[];
      const insLs = db.prepare(
        "INSERT OR IGNORE INTO school_lesson_students (lesson_id, student_id) VALUES (?, ?)",
      );
      for (const sid of after) {
        if (before.has(sid)) continue;
        for (const l of future) insLs.run(l.id, sid);
      }
    }
    audit(db, c.sub, "update", "series", id, s);
    return { ok: true };
  });

  api.delete("/series/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const existing = getSeries(db, id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || existing.teacherId !== own)) return forbidden(reply);
    const ts = now();
    db.prepare("UPDATE school_lesson_series SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
      ts,
      ts,
      id,
    );
    audit(db, c.sub, "delete", "series", id);
    return { ok: true };
  });

  /* --------------------------------------------------------------- lessons */

  api.get("/lessons", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const q = req.query as { from?: string; to?: string; teacherId?: string; studentId?: string };
    const from = q.from ?? new Date().toISOString().slice(0, 10);
    const to = q.to ?? from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return reply.code(400).send({ error: "bad date range" });
    }
    materializeLessons(db, from, to);
    const scope = lessonScope(c, db);
    const rows = db
      .prepare(
        `SELECT l.*, p.name AS teacherName, sp.name AS substituteName, lt.name AS typeName
         FROM school_lessons l
         JOIN school_persons p ON p.id = l.teacher_id
         LEFT JOIN school_persons sp ON sp.id = l.substitute_teacher_id
         LEFT JOIN school_lesson_types lt ON lt.id = l.lesson_type_id
         WHERE l.date >= ? AND l.date <= ?
         ORDER BY l.date, l.start_time`,
      )
      .all(from, to) as Record<string, unknown>[];
    const lessons = rows.map((r) => ({
      ...mapRow<Lesson>(r, LESSON_MAP),
      teacherName: r.teacherName,
      substituteName: r.substituteName,
      typeName: r.typeName,
      students: lessonStudents(db, String(r.id)),
    }));
    const visible = lessons.filter((l) => {
      if (isAdmin(c)) {
        if (q.teacherId && l.teacherId !== q.teacherId && l.substituteTeacherId !== q.teacherId)
          return false;
      } else {
        // Teacher sees own lessons fully; others' lessons only as busy slots.
        const isOwn =
          scope.teacherId &&
          (l.teacherId === scope.teacherId || l.substituteTeacherId === scope.teacherId);
        if (scope.teacherId && !isOwn) {
          if (q.teacherId && l.teacherId !== q.teacherId) return false;
          return true; // read-only conflict view — students stripped below
        }
        if (!scope.teacherId && scope.studentIds) {
          const has = l.students.some((s) => scope.studentIds?.has(String(s.studentId)));
          if (!has) return false;
        }
      }
      if (q.studentId && !l.students.some((s) => String(s.studentId) === q.studentId)) return false;
      return true;
    });
    const out = visible.map((l) => {
      if (!isAdmin(c) && !scope.teacherId && scope.studentIds) {
        // Parents/students see only their own students' rows — no private fields.
        return {
          ...l,
          students: l.students
            .filter((s) => scope.studentIds?.has(String(s.studentId)))
            .map((s) => ({
              studentId: s.studentId,
              studentName: s.studentName,
              attendance: s.attendance,
              publicNote: s.publicNote,
            })),
        };
      }
      // Teacher viewing other teachers' lessons: opaque busy slots only.
      if (
        scope.teacherId &&
        l.teacherId !== scope.teacherId &&
        l.substituteTeacherId !== scope.teacherId &&
        !isAdmin(c)
      ) {
        return busySlot(l);
      }
      return l;
    });
    return { lessons: out.map(lessonOut), generated: { from, to } };
  });

  api.post("/lessons/check", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const parsed = checkIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    // Non-admin probes are scoped to the caller's own teacher/students — otherwise
    // the conflict details are an existence oracle into colleagues' schedules.
    if (!isAdmin(c)) {
      const own = ownTeacherId(c);
      if (!own || b.teacherId !== own) return forbidden(reply);
      const mine = teacherStudentIds(db, own);
      if (b.studentIds.some((sid) => !mine.has(sid))) return forbidden(reply);
    }
    return {
      conflicts: detectConflicts(db, {
        date: b.date,
        startMin: toMin(b.startTime),
        durationMin: b.durationMin,
        teacherId: b.teacherId,
        studentIds: b.studentIds,
        excludeLessonId: b.excludeLessonId,
      }),
    };
  });

  api.post("/lessons", async (req, reply) => {
    const c = caller(req);
    const parsed = lessonIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const own = ownTeacherId(c);
    const teacherId = b.teacherId ?? own;
    if (!teacherId) return reply.code(422).send({ error: "teacherId required" });
    if (!isAdmin(c) && (!own || teacherId !== own)) return forbidden(reply);
    materializeLessons(db, b.date, b.date);
    const conflicts = detectConflicts(db, {
      date: b.date,
      startMin: toMin(b.startTime),
      durationMin: b.durationMin,
      teacherId,
      studentIds: b.studentIds,
    });
    if (conflicts.length > 0 && !b.force) {
      return reply.code(409).send({ error: "conflicts", conflicts });
    }
    if (conflicts.length > 0 && b.force && !isAdmin(c)) return forbidden(reply);
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO school_lessons
         (id, series_id, teacher_id, lesson_type_id, date, start_time, duration_min, location,
          status, is_makeup, makeup_for_lesson_id, override_conflicts, notes, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      teacherId,
      b.lessonTypeId ?? null,
      b.date,
      b.startTime,
      b.durationMin,
      b.location ?? null,
      b.isMakeup ? 1 : 0,
      b.makeupForLessonId ?? null,
      conflicts.length > 0 ? 1 : 0,
      b.notes ?? null,
      ts,
      ts,
    );
    for (const sid of b.studentIds) {
      if (!validStudent(db, sid)) {
        return reply.code(422).send({ error: `unknown student ${sid}` });
      }
    }
    if (b.makeupRequestId) {
      const mr = db
        .prepare("SELECT student_id AS sid, status FROM school_makeup_requests WHERE id = ?")
        .get(b.makeupRequestId) as { sid: string; status: string } | undefined;
      if (mr?.status !== "open" || !b.studentIds.includes(mr.sid)) {
        return reply
          .code(422)
          .send({ error: "makeupRequestId is not an open request of a listed student" });
      }
    }
    const ins = db.prepare(
      "INSERT INTO school_lesson_students (lesson_id, student_id) VALUES (?, ?)",
    );
    for (const sid of b.studentIds) ins.run(id, sid);
    if (b.makeupRequestId) {
      db.prepare(
        "UPDATE school_makeup_requests SET status = 'scheduled', makeup_lesson_id = ? WHERE id = ? AND status = 'open'",
      ).run(id, b.makeupRequestId);
    }
    audit(db, c.sub, "create", "lesson", id, { ...b, conflicts });
    return reply.code(201).send({ id, conflicts });
  });

  api.get("/lessons/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db
      .prepare(
        `SELECT l.*, p.name AS teacherName, sp.name AS substituteName, lt.name AS typeName
         FROM school_lessons l
         JOIN school_persons p ON p.id = l.teacher_id
         LEFT JOIN school_persons sp ON sp.id = l.substitute_teacher_id
         LEFT JOIN school_lesson_types lt ON lt.id = l.lesson_type_id
         WHERE l.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const l = mapRow<Lesson>(row, LESSON_MAP);
    const scope = lessonScope(c, db);
    const isOwn =
      scope.teacherId &&
      (l.teacherId === scope.teacherId || l.substituteTeacherId === scope.teacherId);
    if (!isAdmin(c) && !isOwn) {
      const hasStudent =
        scope.studentIds?.size &&
        lessonStudents(db, id).some((s) => scope.studentIds?.has(String(s.studentId)));
      // Teachers get an opaque busy slot for foreign lessons.
      if (scope.teacherId && !hasStudent) return { lesson: busySlot(l) };
      if (!hasStudent) return forbidden(reply);
      // Parents/students see only their own students' rows — no private fields.
      const students = lessonStudents(db, id)
        .filter((s) => scope.studentIds?.has(String(s.studentId)))
        .map((s) => ({
          studentId: s.studentId,
          studentName: s.studentName,
          attendance: s.attendance,
          publicNote: s.publicNote,
        }));
      return {
        lesson: {
          ...l,
          teacherName: row.teacherName,
          substituteName: row.substituteName,
          typeName: row.typeName,
          students,
        },
      };
    }
    return {
      lesson: {
        ...l,
        teacherName: row.teacherName,
        substituteName: row.substituteName,
        typeName: row.typeName,
        students: lessonStudents(db, id),
      },
    };
  });

  api.patch("/lessons/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db.prepare(`SELECT ${"*"} FROM school_lessons WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const l = mapRow<Lesson>(row, LESSON_MAP);
    const parsed = lessonPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const own = ownTeacherId(c);
    const isOwner = isAdmin(c) || (own != null && l.teacherId === own);
    const isSub = !isOwner && own != null && l.substituteTeacherId === own;
    if (!isOwner && !isSub) return forbidden(reply);
    if (isSub) {
      // Substitutes mark attendance; lesson fields are limited to notes/cancel reason.
      const restricted = [
        b.date,
        b.startTime,
        b.durationMin,
        b.location,
        b.teacherId,
        b.substituteTeacherId,
        b.status,
        b.addStudentIds,
        b.removeStudentIds,
        b.force,
      ].some((v) => v !== undefined);
      if (restricted) return forbidden(reply);
    }
    // Billing-significant status + ownership reassignment are admin-only.
    if (!isAdmin(c)) {
      if (b.status === "cancelled_school") return forbidden(reply);
      if (b.teacherId !== undefined || b.substituteTeacherId !== undefined) {
        return forbidden(reply);
      }
    }
    if (b.addStudentIds) {
      for (const sid of b.addStudentIds) {
        if (!validStudent(db, sid)) {
          return reply.code(422).send({ error: `unknown student ${sid}` });
        }
      }
    }
    const date = b.date ?? l.date;
    const startTime = b.startTime ?? l.startTime;
    const durationMin = b.durationMin ?? l.durationMin;
    const teacherId = b.teacherId ?? l.teacherId;
    const studentIds = (
      db
        .prepare("SELECT student_id AS id FROM school_lesson_students WHERE lesson_id = ?")
        .all(id) as { id: string }[]
    ).map((r) => r.id);
    const moved =
      date !== l.date ||
      startTime !== l.startTime ||
      durationMin !== l.durationMin ||
      teacherId !== l.teacherId;
    let conflicts: ReturnType<typeof detectConflicts> = [];
    if (moved || (b.addStudentIds?.length ?? 0) > 0) {
      conflicts = detectConflicts(db, {
        date,
        startMin: toMin(startTime),
        durationMin,
        teacherId: b.substituteTeacherId ?? teacherId,
        studentIds: [...new Set([...studentIds, ...(b.addStudentIds ?? [])])],
        excludeLessonId: id,
      });
      if (conflicts.length > 0 && !b.force) {
        return reply.code(409).send({ error: "conflicts", conflicts });
      }
      if (conflicts.length > 0 && b.force && !isAdmin(c)) return forbidden(reply);
    }
    const fields: Record<string, SQLInputValue | undefined> = {
      date: b.date,
      start_time: b.startTime,
      duration_min: b.durationMin,
      location: b.location,
      teacher_id: b.teacherId,
      substitute_teacher_id: b.substituteTeacherId,
      status: b.status,
      cancel_reason: b.cancelReason,
      notes: b.notes,
      override_conflicts: conflicts.length > 0 ? 1 : undefined,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      db.prepare(`UPDATE school_lessons SET ${sets.join(", ")} WHERE id = ?`).run(
        ...args,
        now(),
        id,
      );
    }
    if (b.addStudentIds) {
      const ins = db.prepare(
        "INSERT OR IGNORE INTO school_lesson_students (lesson_id, student_id) VALUES (?, ?)",
      );
      for (const sid of b.addStudentIds) ins.run(id, sid);
    }
    if (b.removeStudentIds) {
      const del = db.prepare(
        "DELETE FROM school_lesson_students WHERE lesson_id = ? AND student_id = ?",
      );
      for (const sid of b.removeStudentIds) del.run(id, sid);
    }
    audit(db, c.sub, "update", "lesson", id, { ...b, conflicts });
    return { ok: true, conflicts };
  });

  /* ------------------------------------------------------------- attendance */

  api.put("/lessons/:id/attendance", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT * FROM school_lessons WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const l = mapRow<Lesson>(row, LESSON_MAP);
    if (!canManageLesson(c, l)) return forbidden(reply);
    const parsed = attendanceIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const a = parsed.data;
    const exists = db
      .prepare("SELECT 1 FROM school_lesson_students WHERE lesson_id = ? AND student_id = ?")
      .get(id, a.studentId);
    if (!exists) return reply.code(404).send({ error: "student not in lesson" });
    db.prepare(
      `UPDATE school_lesson_students
       SET attendance = ?, private_note = COALESCE(?, private_note),
           public_note = COALESCE(?, public_note), practice = COALESCE(?, practice),
           marked_by_sub = ?, marked_at = ?
       WHERE lesson_id = ? AND student_id = ?`,
    ).run(
      a.attendance,
      a.privateNote ?? null,
      a.publicNote ?? null,
      a.practice ?? null,
      c.sub,
      now(),
      id,
      a.studentId,
    );
    audit(db, c.sub, "attendance", "lesson", id, {
      studentId: a.studentId,
      attendance: a.attendance,
    });
    return { ok: true };
  });

  /** Parent/student reports an absence; optionally requests a make-up lesson. */
  api.post("/lessons/:id/report-absence", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db.prepare("SELECT * FROM school_lessons WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const l = mapRow<Lesson>(row, LESSON_MAP);
    const parsed = reportAbsenceIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const a = parsed.data;
    const mine = a.studentId === ownStudentId(c) || guardianStudentIds(db, c.sub).has(a.studentId);
    if (!isAdmin(c) && !mine) return forbidden(reply);
    // Absences are reported for scheduled current/future lessons only — rewriting
    // recorded past attendance alters billed amounts.
    if (!isAdmin(c) && (l.status !== "scheduled" || l.date < todayBerlin())) {
      return reply.code(409).send({ error: "lesson is not reportable" });
    }
    const enrolled = db
      .prepare(
        "SELECT attendance FROM school_lesson_students WHERE lesson_id = ? AND student_id = ?",
      )
      .get(id, a.studentId) as { attendance: string | null } | undefined;
    if (!enrolled) return reply.code(404).send({ error: "student not in lesson" });
    // Never overwrite recorded attendance (correction is a teacher/admin action).
    if (enrolled.attendance !== null && !isAdmin(c)) {
      return reply.code(409).send({ error: "attendance already recorded" });
    }
    db.prepare(
      `UPDATE school_lesson_students SET attendance = 'absent_excused',
           marked_by_sub = COALESCE(marked_by_sub, ?), marked_at = COALESCE(marked_at, ?)
       WHERE lesson_id = ? AND student_id = ?`,
    ).run(c.sub, now(), id, a.studentId);
    // Lesson-level cancellation only when ALL students are now absent/cancelled
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM school_lesson_students
         WHERE lesson_id = ? AND (attendance IS NULL OR attendance = 'attended')`,
      )
      .get(id) as { n: number };
    if (remaining.n === 0) {
      db.prepare(
        `UPDATE school_lessons SET status = 'cancelled_parent', cancel_reason = ?, updated_at = ?
         WHERE id = ? AND status = 'scheduled'`,
      ).run(a.reason ?? "parent cancellation", now(), id);
    }
    let requestId: string | null = null;
    if (a.wantMakeup) {
      requestId = uuid();
      db.prepare(
        `INSERT INTO school_makeup_requests (id, student_id, lesson_id, requested_by_sub, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(requestId, a.studentId, id, c.sub, a.reason ?? null, now());
    }
    audit(db, c.sub, "report_absence", "lesson", id, a);
    return { ok: true, makeupRequestId: requestId };
  });

  api.get("/makeup-requests", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT m.*, p.name AS studentName, l.date AS lessonDate, l.start_time AS lessonTime
         FROM school_makeup_requests m
         JOIN school_persons p ON p.id = m.student_id
         JOIN school_lessons l ON l.id = m.lesson_id
         ORDER BY m.created_at DESC`,
      )
      .all() as Record<string, unknown>[];
    const scope = lessonScope(c, db);
    const out = rows
      .map((r) => ({
        id: r.id,
        studentId: r.student_id,
        studentName: r.studentName,
        lessonId: r.lesson_id,
        lessonDate: r.lessonDate,
        lessonTime: r.lessonTime,
        requestedBySub: r.requested_by_sub,
        status: r.status,
        note: r.note,
        makeupLessonId: r.makeup_lesson_id,
        createdAt: r.created_at,
      }))
      .filter((r) => {
        if (isAdmin(c)) return true;
        if (scope.teacherId) {
          const l = db
            .prepare("SELECT teacher_id AS t FROM school_lessons WHERE id = ?")
            .get(String(r.lessonId)) as { t: string } | undefined;
          return l?.t === scope.teacherId;
        }
        return scope.studentIds?.has(String(r.studentId)) ?? false;
      });
    return { requests: out };
  });

  api.patch("/makeup-requests/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const parsed = z
      .object({
        status: z.enum(["open", "scheduled", "declined", "done"]),
        note: z.string().max(1000).nullish(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const r = db.prepare("SELECT * FROM school_makeup_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return reply.code(404).send({ error: "not found" });
    const l = db
      .prepare("SELECT teacher_id AS t FROM school_lessons WHERE id = ?")
      .get(String(r.lesson_id)) as { t: string } | undefined;
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || l?.t !== own)) return forbidden(reply);
    db.prepare(
      "UPDATE school_makeup_requests SET status = ?, note = COALESCE(?, note) WHERE id = ?",
    ).run(parsed.data.status, parsed.data.note ?? null, id);
    audit(db, c.sub, "update", "makeup_request", id, parsed.data);
    return { ok: true };
  });

  /* -------------------------------------------------------------- holidays */

  api.get("/holidays", async () => ({
    holidays: db
      .prepare(
        `SELECT id, name, start_date AS startDate, end_date AS endDate, kind
         FROM school_holidays ORDER BY start_date`,
      )
      .all(),
  }));

  api.post("/holidays", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = holidayIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const h = parsed.data;
    if (h.endDate < h.startDate) return reply.code(422).send({ error: "endDate < startDate" });
    const id = uuid();
    db.prepare(
      "INSERT INTO school_holidays (id, name, start_date, end_date, kind) VALUES (?, ?, ?, ?, ?)",
    ).run(id, h.name, h.startDate, h.endDate, h.kind);
    // Auto-cancel materialized lessons inside the closure (D56).
    const res = db
      .prepare(
        `UPDATE school_lessons SET status = 'cancelled_school', cancel_reason = ?, updated_at = ?
         WHERE date >= ? AND date <= ? AND status = 'scheduled'`,
      )
      .run(h.name, now(), h.startDate, h.endDate);
    audit(db, c.sub, "create", "holiday", id, { ...h, cancelled: Number(res.changes) });
    return reply.code(201).send({ id, cancelledLessons: Number(res.changes) });
  });

  api.delete("/holidays/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const res = db.prepare("DELETE FROM school_holidays WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "delete", "holiday", id);
    return { ok: true };
  });

  /* ----------------------------------------------------------- availability */

  api.get("/availability", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const q = req.query as { teacherId?: string };
    let sql = `SELECT a.id, a.teacher_id AS teacherId, p.name AS teacherName, a.weekday,
                      a.start_time AS startTime, a.end_time AS endTime,
                      a.valid_from AS validFrom, a.valid_until AS validUntil
               FROM school_teacher_availability a
               JOIN school_persons p ON p.id = a.teacher_id`;
    const args: SQLInputValue[] = [];
    const own = ownTeacherId(c);
    if (!isAdmin(c)) {
      sql += " WHERE a.teacher_id = ?";
      args.push(own ?? "");
    } else if (q.teacherId) {
      sql += " WHERE a.teacher_id = ?";
      args.push(q.teacherId);
    }
    return {
      availability: db
        .prepare(`${sql} ORDER BY a.teacher_id, a.weekday, a.start_time`)
        .all(...args),
    };
  });

  api.post("/availability", async (req, reply) => {
    const c = caller(req);
    const parsed = availIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const a = parsed.data;
    const own = ownTeacherId(c);
    const teacherId = a.teacherId ?? own;
    if (!teacherId) return reply.code(422).send({ error: "teacherId required" });
    if (!isAdmin(c) && (!own || teacherId !== own)) return forbidden(reply);
    if (a.endTime <= a.startTime) return reply.code(422).send({ error: "endTime <= startTime" });
    const id = uuid();
    db.prepare(
      `INSERT INTO school_teacher_availability
         (id, teacher_id, weekday, start_time, end_time, valid_from, valid_until)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, teacherId, a.weekday, a.startTime, a.endTime, a.validFrom, a.validUntil ?? null);
    audit(db, c.sub, "create", "availability", id, a);
    return reply.code(201).send({ id });
  });

  api.delete("/availability/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db
      .prepare("SELECT teacher_id AS t FROM school_teacher_availability WHERE id = ?")
      .get(id) as { t: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || row.t !== own)) return forbidden(reply);
    db.prepare("DELETE FROM school_teacher_availability WHERE id = ?").run(id);
    audit(db, c.sub, "delete", "availability", id);
    return { ok: true };
  });

  /* -------------------------------------------------------------- absences */

  api.get("/absences", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const q = req.query as { teacherId?: string };
    let sql = `SELECT a.id, a.teacher_id AS teacherId, p.name AS teacherName,
                      a.start_date AS startDate, a.end_date AS endDate, a.kind, a.note
               FROM school_teacher_absences a JOIN school_persons p ON p.id = a.teacher_id`;
    const args: SQLInputValue[] = [];
    const own = ownTeacherId(c);
    if (!isAdmin(c)) {
      sql += " WHERE a.teacher_id = ?";
      args.push(own ?? "");
    } else if (q.teacherId) {
      sql += " WHERE a.teacher_id = ?";
      args.push(q.teacherId);
    }
    return { absences: db.prepare(`${sql} ORDER BY a.start_date`).all(...args) };
  });

  api.post("/absences", async (req, reply) => {
    const c = caller(req);
    const parsed = absenceIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const a = parsed.data;
    const own = ownTeacherId(c);
    const teacherId = a.teacherId ?? own;
    if (!teacherId) return reply.code(422).send({ error: "teacherId required" });
    if (!isAdmin(c) && (!own || teacherId !== own)) return forbidden(reply);
    if (a.endDate < a.startDate) return reply.code(422).send({ error: "endDate < startDate" });
    const id = uuid();
    db.prepare(
      `INSERT INTO school_teacher_absences (id, teacher_id, start_date, end_date, kind, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, teacherId, a.startDate, a.endDate, a.kind, a.note ?? null);
    audit(db, c.sub, "create", "absence", id, a);
    return reply.code(201).send({ id });
  });

  api.delete("/absences/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db
      .prepare("SELECT teacher_id AS t FROM school_teacher_absences WHERE id = ?")
      .get(id) as { t: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const own = ownTeacherId(c);
    if (!isAdmin(c) && (!own || row.t !== own)) return forbidden(reply);
    db.prepare("DELETE FROM school_teacher_absences WHERE id = ?").run(id);
    audit(db, c.sub, "delete", "absence", id);
    return { ok: true };
  });

  /* --------------------------------------------------------------- utility */

  // expose weekday helper for the app? not needed — client computes.
  void weekdayOf;
}
