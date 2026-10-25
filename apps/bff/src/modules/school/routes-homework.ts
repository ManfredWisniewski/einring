import { createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app.js";
import { audit, now, person } from "./db.js";
import { postDirect } from "./delivery.js";
import { guardianStudentIds, teacherStudentIds, uuid } from "./domain.js";
import {
  type Caller,
  callerOf,
  forbidden,
  isAdmin,
  needRole,
  ownStudentId,
  ownTeacherId,
  type SchoolConfig,
} from "./scope.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const homeworkIn = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20000).default(""),
  musicxml: z.string().max(2_000_000).nullish(),
  musicxmlName: z.string().max(200).nullish(),
  teacherId: z.string().nullish(), // admin only: assign ownership
});
const homeworkPatch = homeworkIn.omit({ teacherId: true }).partial();

const assignIn = z.object({
  homeworkId: z.string(),
  studentIds: z.array(z.string()).min(1).max(100),
  note: z.string().max(2000).nullish(),
  dueDate: z.string().regex(DATE).nullish(),
});
const assignmentPatch = z.object({
  note: z.string().max(2000).nullish(),
  dueDate: z.string().regex(DATE).nullish(),
  status: z.enum(["assigned", "submitted", "reviewed"]).optional(),
  feedback: z.string().max(2000).nullish(),
});
const submissionIn = z.object({ message: z.string().min(1).max(4000) });

/** Subs linked to the student profile plus its household guardians. */
function studentReachableSubs(db: DatabaseSync, studentId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p2.sub AS sub FROM school_persons p2
       WHERE p2.sub IS NOT NULL AND p2.deleted_at IS NULL AND (
         p2.id = ?
         OR p2.id IN (
           SELECT m2.person_id FROM school_household_members m1
           JOIN school_household_members m2 ON m2.household_id = m1.household_id
           WHERE m1.person_id = ? AND m2.relation = 'guardian'
         )
       )`,
    )
    .all(studentId, studentId) as { sub: string }[];
  return rows.map((r) => r.sub);
}

/** May the caller act on behalf of this student (self or household guardian)? */
function studentProxy(db: DatabaseSync, c: Caller, studentId: string): boolean {
  return ownStudentId(c) === studentId || guardianStudentIds(db, c.sub).has(studentId);
}

/** Caller may see/manage this homework item (owner teacher or admin). */
function ownsHomework(c: Caller, teacherId: string): boolean {
  return isAdmin(c) || ownTeacherId(c) === teacherId;
}

export function registerHomeworkRoutes(
  api: FastifyInstance,
  db: DatabaseSync,
  cfg: SchoolConfig,
  ctx: AppContext,
  mediaDir: string,
): void {
  const caller = (req: FastifyRequest) => callerOf(db, req, cfg);
  const notify = (from: string, to: string[], title: string, body: string) =>
    postDirect(db, cfg, ctx.fetchImpl ?? fetch, from, to, title, body);

  // Raw audio/video upload (D57) — same raw-body pattern as einmusic (D48).
  api.addContentTypeParser(
    /^(audio\/|video\/|application\/octet-stream)/,
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  const getAssignment = (id: string) =>
    db
      .prepare(
        `SELECT a.*, h.teacher_id AS teacherId, h.title AS homeworkTitle
         FROM school_homework_assignments a
         JOIN school_homework h ON h.id = a.homework_id AND h.deleted_at IS NULL
         WHERE a.id = ?`,
      )
      .get(id) as
      | (Record<string, unknown> & { teacherId: string; student_id: string; status: string })
      | undefined;

  const submissionRows = (assignmentId: string) =>
    db
      .prepare(
        `SELECT id, message, media_name AS mediaName, media_mime AS mediaMime,
                media_bytes AS mediaBytes, created_at AS createdAt
         FROM school_homework_submissions WHERE assignment_id = ? ORDER BY created_at`,
      )
      .all(assignmentId);

  /* -------------------------------------------------------------- library */

  api.get("/homework", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const rows = (
      isAdmin(c)
        ? db
            .prepare(
              `SELECT h.*, p.name AS teacherName FROM school_homework h
               LEFT JOIN school_persons p ON p.id = h.teacher_id
               WHERE h.deleted_at IS NULL ORDER BY h.title`,
            )
            .all()
        : db
            .prepare(
              `SELECT h.*, p.name AS teacherName FROM school_homework h
               LEFT JOIN school_persons p ON p.id = h.teacher_id
               WHERE h.deleted_at IS NULL AND h.teacher_id = ? ORDER BY h.title`,
            )
            .all(ownTeacherId(c) ?? "")
    ) as Record<string, unknown>[];
    return {
      homework: rows.map((h) => ({
        id: h.id,
        teacherId: h.teacher_id,
        teacherName: h.teacherName,
        title: h.title,
        body: h.body,
        musicxmlName: h.musicxml_name,
        hasMusicxml: h.musicxml != null,
        createdAt: h.created_at,
        updatedAt: h.updated_at,
      })),
    };
  });

  /** Full homework detail incl. MusicXML — for students/parents via assignment. */
  api.get("/homework/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const h = db
      .prepare(
        `SELECT h.*, p.name AS teacherName FROM school_homework h
         LEFT JOIN school_persons p ON p.id = h.teacher_id
         WHERE h.id = ? AND h.deleted_at IS NULL`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!h) return reply.code(404).send({ error: "not found" });
    if (!ownsHomework(c, String(h.teacher_id))) {
      // students/guardians may read it only when it is assigned to them
      const mine = new Set([
        ...(ownStudentId(c) ? [ownStudentId(c) as string] : []),
        ...guardianStudentIds(db, c.sub),
      ]);
      const assigned = db
        .prepare("SELECT student_id AS s FROM school_homework_assignments WHERE homework_id = ?")
        .all(id) as { s: string }[];
      if (!assigned.some((a) => mine.has(a.s))) return forbidden(reply);
    }
    return {
      homework: {
        id: h.id,
        teacherId: h.teacher_id,
        teacherName: h.teacherName,
        title: h.title,
        body: h.body,
        musicxml: h.musicxml,
        musicxmlName: h.musicxml_name,
        createdAt: h.created_at,
        updatedAt: h.updated_at,
      },
    };
  });

  api.post("/homework", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const parsed = homeworkIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const teacherId = isAdmin(c) && b.teacherId ? b.teacherId : ownTeacherId(c);
    if (!teacherId) return reply.code(422).send({ error: "no linked teacher profile" });
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO school_homework (id, teacher_id, title, body, musicxml, musicxml_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, teacherId, b.title, b.body, b.musicxml ?? null, b.musicxmlName ?? null, ts, ts);
    audit(db, c.sub, "create", "homework", id, { title: b.title });
    return reply.code(201).send({ id });
  });

  api.patch("/homework/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const id = (req.params as { id: string }).id;
    const h = db
      .prepare("SELECT teacher_id FROM school_homework WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { teacher_id: string } | undefined;
    if (!h) return reply.code(404).send({ error: "not found" });
    if (!ownsHomework(c, h.teacher_id)) return forbidden(reply);
    const parsed = homeworkPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      title: b.title,
      body: b.body,
      musicxml: b.musicxml,
      musicxml_name: b.musicxmlName,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    sets.push("updated_at = ?");
    db.prepare(`UPDATE school_homework SET ${sets.join(", ")} WHERE id = ?`).run(
      ...args,
      now(),
      id,
    );
    audit(db, c.sub, "update", "homework", id, b);
    return { ok: true };
  });

  api.delete("/homework/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const id = (req.params as { id: string }).id;
    const h = db
      .prepare("SELECT teacher_id FROM school_homework WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { teacher_id: string } | undefined;
    if (!h) return reply.code(404).send({ error: "not found" });
    if (!ownsHomework(c, h.teacher_id)) return forbidden(reply);
    // Cascade: descendant rows and their media files go with the homework.
    const subs = db
      .prepare(
        `SELECT s.id FROM school_homework_submissions s
         JOIN school_homework_assignments a ON a.id = s.assignment_id
         WHERE a.homework_id = ?`,
      )
      .all(id) as { id: string }[];
    db.prepare(
      `DELETE FROM school_homework_submissions WHERE assignment_id IN
       (SELECT id FROM school_homework_assignments WHERE homework_id = ?)`,
    ).run(id);
    db.prepare("DELETE FROM school_homework_assignments WHERE homework_id = ?").run(id);
    db.prepare("UPDATE school_homework SET deleted_at = ? WHERE id = ?").run(now(), id);
    for (const s of subs) {
      try {
        unlinkSync(join(mediaDir, s.id));
      } catch {
        /* already gone */
      }
    }
    audit(db, c.sub, "delete", "homework", id);
    return { ok: true };
  });

  /* ---------------------------------------------------------- assignments */

  api.get("/homework/assignments", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT a.*, h.title AS homeworkTitle, h.teacher_id AS teacherId,
                tp.name AS teacherName, sp.name AS studentName
         FROM school_homework_assignments a
         JOIN school_homework h ON h.id = a.homework_id AND h.deleted_at IS NULL
         LEFT JOIN school_persons tp ON tp.id = h.teacher_id
         JOIN school_persons sp ON sp.id = a.student_id
         ORDER BY a.due_date, a.created_at DESC`,
      )
      .all() as (Record<string, unknown> & { teacherId: string; student_id: string })[];
    const mine = new Set([
      ...(ownStudentId(c) ? [ownStudentId(c) as string] : []),
      ...guardianStudentIds(db, c.sub),
    ]);
    const scoped = rows.filter(
      (a) => isAdmin(c) || ownTeacherId(c) === a.teacherId || mine.has(a.student_id),
    );
    return {
      assignments: scoped.map((a) => ({
        id: a.id,
        homeworkId: a.homework_id,
        homeworkTitle: a.homeworkTitle,
        teacherId: a.teacherId,
        teacherName: a.teacherName,
        studentId: a.student_id,
        studentName: a.studentName,
        note: a.note,
        dueDate: a.due_date,
        status: a.status,
        feedback: a.feedback,
        createdAt: a.created_at,
        submissions: submissionRows(String(a.id)),
      })),
    };
  });

  api.post("/homework/assign", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const parsed = assignIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const h = db
      .prepare(
        "SELECT id, teacher_id AS teacherId, title FROM school_homework WHERE id = ? AND deleted_at IS NULL",
      )
      .get(b.homeworkId) as { id: string; teacherId: string; title: string } | undefined;
    if (!h) return reply.code(404).send({ error: "homework not found" });
    if (!ownsHomework(c, h.teacherId)) return forbidden(reply);
    const allowed = isAdmin(c) ? null : teacherStudentIds(db, h.teacherId);
    const ids: string[] = [];
    const ts = now();
    const up = db.prepare(
      `INSERT INTO school_homework_assignments
         (id, homework_id, student_id, note, due_date, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'assigned', ?, ?)
       ON CONFLICT(homework_id, student_id) DO UPDATE SET
         note = excluded.note, due_date = excluded.due_date,
         status = 'assigned', updated_at = excluded.updated_at`,
    );
    for (const sid of b.studentIds) {
      if (allowed && !allowed.has(sid)) {
        return reply.code(403).send({ error: `student ${sid} is not yours` });
      }
      if (person(db, sid)?.kind !== "student") {
        return reply.code(422).send({ error: `unknown student ${sid}` });
      }
      up.run(uuid(), h.id, sid, b.note ?? null, b.dueDate ?? null, ts, ts);
      ids.push(sid);
    }
    audit(db, c.sub, "assign", "homework", h.id, { students: ids.length });
    // Notify each student's household (student + guardians) via a direct thread.
    const teacherName = person(db, h.teacherId)?.name ?? "Teacher";
    for (const sid of ids) {
      const subs = studentReachableSubs(db, sid).filter((s) => s !== c.sub);
      if (subs.length === 0) continue;
      const studentName = person(db, sid)?.name ?? "";
      await notify(
        c.sub,
        subs,
        "Hausaufgabe",
        `Neue Hausaufgabe für ${studentName} von ${teacherName}: „${h.title}"` +
          (b.dueDate ? ` (bis ${b.dueDate})` : "") +
          (b.note ? `\n${b.note}` : ""),
      );
    }
    return reply.code(201).send({ assigned: ids.length });
  });

  api.patch("/homework/assignments/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const id = (req.params as { id: string }).id;
    const a = getAssignment(id);
    if (!a) return reply.code(404).send({ error: "not found" });
    if (!ownsHomework(c, a.teacherId)) return forbidden(reply);
    const parsed = assignmentPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      note: b.note,
      due_date: b.dueDate,
      status: b.status,
      feedback: b.feedback,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    sets.push("updated_at = ?");
    db.prepare(`UPDATE school_homework_assignments SET ${sets.join(", ")} WHERE id = ?`).run(
      ...args,
      now(),
      id,
    );
    audit(db, c.sub, "update", "homework_assignment", id, b);
    return { ok: true };
  });

  /* ---------------------------------------------------------- submissions */

  api.post("/homework/assignments/:id/submissions", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const a = getAssignment(id);
    if (!a) return reply.code(404).send({ error: "not found" });
    if (!studentProxy(db, c, a.student_id)) return forbidden(reply);
    if (a.status === "reviewed") return reply.code(409).send({ error: "already reviewed" });
    const parsed = submissionIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const sid = uuid();
    db.prepare(
      `INSERT INTO school_homework_submissions (id, assignment_id, message, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(sid, id, parsed.data.message, now());
    db.prepare(
      "UPDATE school_homework_assignments SET status = 'submitted', updated_at = ? WHERE id = ? AND status = 'assigned'",
    ).run(now(), id);
    audit(db, c.sub, "create", "homework_submission", sid, { assignment: id });
    const teacherSub = (
      db.prepare("SELECT sub FROM school_persons WHERE id = ?").get(a.teacherId) as
        | { sub: string }
        | undefined
    )?.sub;
    if (teacherSub && teacherSub !== c.sub) {
      const studentName = person(db, a.student_id)?.name ?? "";
      await notify(
        c.sub,
        [teacherSub],
        "Hausaufgabe",
        `${studentName} hat „${a.homeworkTitle}" abgegeben.`,
      );
    }
    return reply.code(201).send({ id: sid });
  });

  /** Raw audio/video bytes for a submission (D57): `?name=<file>`. */
  api.put(
    "/homework/submissions/:id/media",
    { bodyLimit: 50 * 1024 * 1024 },
    async (req, reply) => {
      const c = caller(req);
      const id = (req.params as { id: string }).id;
      const s = db
        .prepare(
          `SELECT s.id, a.student_id AS studentId, a.id AS assignmentId
           FROM school_homework_submissions s
           JOIN school_homework_assignments a ON a.id = s.assignment_id
           WHERE s.id = ?`,
        )
        .get(id) as { id: string; studentId: string; assignmentId: string } | undefined;
      if (!s) return reply.code(404).send({ error: "not found" });
      if (!studentProxy(db, c, s.studentId)) return forbidden(reply);
      const asg = getAssignment(s.assignmentId);
      if (!asg) return reply.code(404).send({ error: "not found" });
      if (asg.status === "reviewed") return reply.code(409).send({ error: "already reviewed" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected media bytes as the request body" });
      }
      const name = String((req.query as { name?: string }).name ?? "recording").slice(0, 200);
      const mime = String(req.headers["content-type"] ?? "application/octet-stream");
      mkdirSync(mediaDir, { recursive: true });
      writeFileSync(join(mediaDir, s.id), body);
      db.prepare(
        "UPDATE school_homework_submissions SET media_name = ?, media_mime = ?, media_bytes = ? WHERE id = ?",
      ).run(name, mime, body.length, s.id);
      db.prepare(
        "UPDATE school_homework_assignments SET status = 'submitted', updated_at = ? WHERE id = ? AND status = 'assigned'",
      ).run(now(), s.assignmentId);
      audit(db, c.sub, "upload", "homework_submission", s.id, { bytes: body.length });
      return { ok: true };
    },
  );

  api.get("/homework/submissions/:id/media", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const s = db
      .prepare(
        `SELECT s.id, s.media_mime AS mime, s.media_bytes AS bytes,
                a.student_id AS studentId, h.teacher_id AS teacherId
         FROM school_homework_submissions s
         JOIN school_homework_assignments a ON a.id = s.assignment_id
         JOIN school_homework h ON h.id = a.homework_id AND h.deleted_at IS NULL
         WHERE s.id = ?`,
      )
      .get(id) as
      | {
          id: string;
          mime: string | null;
          bytes: number | null;
          studentId: string;
          teacherId: string;
        }
      | undefined;
    if (!s) return reply.code(404).send({ error: "not found" });
    const allowed =
      isAdmin(c) || ownTeacherId(c) === s.teacherId || studentProxy(db, c, s.studentId);
    if (!allowed) return forbidden(reply);
    const file = join(mediaDir, s.id);
    const size = statSync(file, { throwIfNoEntry: false })?.size;
    if (size === undefined) return reply.code(404).send({ error: "no media" });
    return reply
      .header("Content-Type", s.mime ?? "application/octet-stream")
      .header("Content-Length", size)
      .send(createReadStream(file));
  });
}
