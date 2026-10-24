import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app.js";
import { audit, now } from "./db.js";
import { deliver } from "./delivery.js";
import { allowedPeerSubs, audienceSubs, guardianStudentIds, uuid } from "./domain.js";
import { callerOf, forbidden, isAdmin, isStaff, ownStudentId, type SchoolConfig } from "./scope.js";

const threadIn = z.object({
  kind: z.enum(["direct", "announcement"]).default("direct"),
  title: z.string().max(200).nullish(),
  audience: z.enum(["all", "parents", "teachers", "students"]).nullish(),
  memberSubs: z.array(z.string().min(1).max(200)).max(200).optional(),
  body: z.string().min(1).max(8000),
});
const messageIn = z.object({ body: z.string().min(1).max(8000) });

const eventIn = z.object({
  kind: z.enum(["concert", "recital", "exam", "other"]).default("other"),
  title: z.string().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  endTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  location: z.string().max(200).nullish(),
  description: z.string().max(4000).nullish(),
  teacherId: z.string().nullish(),
});
const eventPatch = eventIn.partial();
const participantsIn = z.object({
  participants: z
    .array(
      z.object({
        studentId: z.string(),
        piece: z.string().max(300).nullish(),
        status: z.enum(["invited", "confirmed", "declined"]).optional(),
      }),
    )
    .max(200),
});
const participantPatch = z.object({
  status: z.enum(["invited", "confirmed", "declined"]),
  piece: z.string().max(300).nullish(),
  note: z.string().max(1000).nullish(),
});
const rehearsalIn = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  durationMin: z.number().int().min(5).max(600).default(60),
  location: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
});

function memberOf(db: DatabaseSync, threadId: string, sub: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM school_thread_members WHERE thread_id = ? AND sub = ?")
    .get(threadId, sub);
}

export function registerSocialRoutes(
  api: FastifyInstance,
  db: DatabaseSync,
  cfg: SchoolConfig,
  ctx: AppContext,
): void {
  const caller = (req: FastifyRequest) => callerOf(db, req, cfg);
  const fanOut = (mid: string, body: string, from: string, subs: string[]) =>
    deliver(db, cfg, ctx.fetchImpl ?? fetch, mid, body, from, subs);

  /* --------------------------------------------------------------- threads */

  api.get("/threads", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT t.id, t.kind, t.title, t.audience, t.created_at AS createdAt,
                m.last_read_at AS lastReadAt,
                (SELECT body FROM school_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastBody,
                (SELECT created_at FROM school_messages WHERE thread_id = t.id ORDER BY created_at DESC LIMIT 1) AS lastAt,
                (SELECT COUNT(*) FROM school_thread_members WHERE thread_id = t.id) AS memberCount
         FROM school_threads t
         JOIN school_thread_members m ON m.thread_id = t.id AND m.sub = ?
         ORDER BY lastAt DESC`,
      )
      .all(c.sub) as Record<string, unknown>[];
    return {
      threads: rows.map((r) => ({
        ...r,
        unread:
          r.lastAt != null && (r.lastReadAt == null || String(r.lastAt) > String(r.lastReadAt)),
      })),
    };
  });

  api.post("/threads", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const parsed = threadIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const b = parsed.data;
    const members = new Set<string>([c.sub]);
    if (b.kind === "announcement") {
      if (!b.audience) return reply.code(422).send({ error: "audience required" });
      if (!isStaff(c)) return forbidden(reply);
      // Teachers announce to their own reachable audience only.
      const base = audienceSubs(db, b.audience);
      if (isAdmin(c)) {
        for (const s of base) members.add(s);
      } else {
        const allowed = allowedPeerSubs(db, c.sub, c.roles, c.person?.id ?? null);
        for (const s of base) if (allowed.has(s)) members.add(s);
      }
    } else {
      const allowed = allowedPeerSubs(db, c.sub, c.roles, c.person?.id ?? null);
      for (const s of b.memberSubs ?? []) {
        if (s !== c.sub && !allowed.has(s)) {
          return reply.code(403).send({ error: `cannot message ${s}` });
        }
        members.add(s);
      }
      if (members.size < 2) return reply.code(422).send({ error: "memberSubs required" });
    }
    const tid = uuid();
    const ts = now();
    db.prepare(
      "INSERT INTO school_threads (id, kind, title, created_by_sub, audience, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(tid, b.kind, b.title ?? null, c.sub, b.audience ?? null, ts);
    const insM = db.prepare(
      "INSERT INTO school_thread_members (thread_id, sub, last_read_at) VALUES (?, ?, ?)",
    );
    for (const s of members) insM.run(tid, s, s === c.sub ? ts : null);
    const mid = uuid();
    db.prepare(
      "INSERT INTO school_messages (id, thread_id, sender_sub, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(mid, tid, c.sub, b.body, ts);
    await fanOut(mid, b.body, c.sub, [...members]);
    audit(db, c.sub, "create", "thread", tid, {
      kind: b.kind,
      audience: b.audience,
      members: members.size,
    });
    return reply.code(201).send({ id: tid });
  });

  api.get("/threads/:id/messages", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    if (!memberOf(db, id, c.sub)) return forbidden(reply);
    const thread = db
      .prepare(
        "SELECT id, kind, title, audience, created_by_sub AS createdBySub, created_at AS createdAt FROM school_threads WHERE id = ?",
      )
      .get(id);
    const messages = db
      .prepare(
        `SELECT m.id, m.sender_sub AS senderSub, u.name AS senderName, m.body, m.created_at AS createdAt
         FROM school_messages m LEFT JOIN school_users u ON u.sub = m.sender_sub
         WHERE m.thread_id = ? ORDER BY m.created_at`,
      )
      .all(id);
    db.prepare(
      "UPDATE school_thread_members SET last_read_at = ? WHERE thread_id = ? AND sub = ?",
    ).run(now(), id, c.sub);
    return { thread, messages };
  });

  api.post("/threads/:id/messages", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    if (!memberOf(db, id, c.sub)) return forbidden(reply);
    const thread = db
      .prepare("SELECT kind, created_by_sub AS creator FROM school_threads WHERE id = ?")
      .get(id) as { kind: string; creator: string } | undefined;
    if (!thread) return reply.code(404).send({ error: "not found" });
    // Announcements are one-way: only staff (creator or admin) may append.
    if (thread.kind === "announcement" && !isStaff(c)) return forbidden(reply);
    const parsed = messageIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const mid = uuid();
    db.prepare(
      "INSERT INTO school_messages (id, thread_id, sender_sub, body, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(mid, id, c.sub, parsed.data.body, now());
    const members = (
      db.prepare("SELECT sub FROM school_thread_members WHERE thread_id = ?").all(id) as {
        sub: string;
      }[]
    ).map((r) => r.sub);
    await fanOut(mid, parsed.data.body, c.sub, members);
    return reply.code(201).send({ id: mid });
  });

  /** Candidate direct-message partners for the compose UI. */
  api.get("/contacts", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const subs = [...allowedPeerSubs(db, c.sub, c.roles, c.person?.id ?? null)];
    const rows = subs.length
      ? (db
          .prepare(
            `SELECT p.sub, p.name, p.kind FROM school_persons p
             WHERE p.sub IN (${subs.map(() => "?").join(",")})
             ORDER BY p.name`,
          )
          .all(...subs) as { sub: string; name: string; kind: string }[])
      : [];
    return { contacts: rows };
  });

  /* ---------------------------------------------------------------- events */

  api.get("/events", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const events = db
      .prepare(
        `SELECT e.*, p.name AS teacherName FROM school_events e
         LEFT JOIN school_persons p ON p.id = e.teacher_id ORDER BY e.date`,
      )
      .all() as Record<string, unknown>[];
    const scoped = events.map((e) => {
      const participants = db
        .prepare(
          `SELECT ep.student_id AS studentId, p.name AS studentName, ep.piece, ep.status, ep.note
           FROM school_event_participants ep JOIN school_persons p ON p.id = ep.student_id
           WHERE ep.event_id = ? ORDER BY p.name`,
        )
        .all(String(e.id)) as Record<string, unknown>[];
      const rehearsals = db
        .prepare(
          `SELECT id, date, start_time AS startTime, duration_min AS durationMin, location, note
           FROM school_event_rehearsals WHERE event_id = ? ORDER BY date, start_time`,
        )
        .all(String(e.id));
      return {
        id: e.id,
        kind: e.kind,
        title: e.title,
        date: e.date,
        startTime: e.start_time,
        endTime: e.end_time,
        location: e.location,
        description: e.description,
        teacherId: e.teacher_id,
        teacherName: e.teacherName,
        createdAt: e.created_at,
        participants:
          isAdmin(c) || c.roles.includes("teacher")
            ? participants
            : participants.filter((p) => {
                const mine = new Set([
                  ...(ownStudentId(c) ? [ownStudentId(c) as string] : []),
                  ...guardianStudentIds(db, c.sub),
                ]);
                return mine.has(String(p.studentId));
              }),
        rehearsals,
      };
    });
    return { events: scoped };
  });

  api.post("/events", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const parsed = eventIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const e = parsed.data;
    const id = uuid();
    db.prepare(
      `INSERT INTO school_events (id, kind, title, date, start_time, end_time, location, description, teacher_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      e.kind,
      e.title,
      e.date,
      e.startTime ?? null,
      e.endTime ?? null,
      e.location ?? null,
      e.description ?? null,
      e.teacherId ?? null,
      now(),
    );
    audit(db, c.sub, "create", "event", id, e);
    return reply.code(201).send({ id });
  });

  api.patch("/events/:id", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const id = (req.params as { id: string }).id;
    const parsed = eventPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const e = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      kind: e.kind,
      title: e.title,
      date: e.date,
      start_time: e.startTime,
      end_time: e.endTime,
      location: e.location,
      description: e.description,
      teacher_id: e.teacherId,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    const res = db
      .prepare(`UPDATE school_events SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args, id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "update", "event", id, e);
    return { ok: true };
  });

  api.delete("/events/:id", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const id = (req.params as { id: string }).id;
    db.prepare("DELETE FROM school_event_participants WHERE event_id = ?").run(id);
    db.prepare("DELETE FROM school_event_rehearsals WHERE event_id = ?").run(id);
    const res = db.prepare("DELETE FROM school_events WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "delete", "event", id);
    return { ok: true };
  });

  /** Replaces the participant list (staff). */
  api.put("/events/:id/participants", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const id = (req.params as { id: string }).id;
    if (!db.prepare("SELECT 1 FROM school_events WHERE id = ?").get(id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const parsed = participantsIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const keep = new Set(parsed.data.participants.map((p) => p.studentId));
    const existing = db
      .prepare("SELECT student_id AS id FROM school_event_participants WHERE event_id = ?")
      .all(id) as { id: string }[];
    const del = db.prepare(
      "DELETE FROM school_event_participants WHERE event_id = ? AND student_id = ?",
    );
    for (const e of existing) if (!keep.has(e.id)) del.run(id, e.id);
    const ins = db.prepare(
      `INSERT INTO school_event_participants (event_id, student_id, piece, status)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_id, student_id) DO UPDATE SET piece = excluded.piece`,
    );
    for (const p of parsed.data.participants)
      ins.run(id, p.studentId, p.piece ?? null, p.status ?? "invited");
    audit(db, c.sub, "update", "event_participants", id, parsed.data.participants);
    return { ok: true };
  });

  /** Parent/student confirms or declines participation (staff may also set it). */
  api.patch("/events/:id/participants/:studentId", async (req, reply) => {
    const c = caller(req);
    const { id, studentId } = req.params as { id: string; studentId: string };
    const parsed = participantPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const mine = studentId === ownStudentId(c) || guardianStudentIds(db, c.sub).has(studentId);
    if (!isStaff(c) && !mine) return forbidden(reply);
    const res = db
      .prepare(
        `UPDATE school_event_participants
         SET status = ?, piece = COALESCE(?, piece), note = COALESCE(?, note)
         WHERE event_id = ? AND student_id = ?`,
      )
      .run(p.status, p.piece ?? null, p.note ?? null, id, studentId);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "rsvp", "event", id, { studentId, status: p.status });
    return { ok: true };
  });

  api.post("/events/:id/rehearsals", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const id = (req.params as { id: string }).id;
    if (!db.prepare("SELECT 1 FROM school_events WHERE id = ?").get(id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const parsed = rehearsalIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const r = parsed.data;
    const rid = uuid();
    db.prepare(
      `INSERT INTO school_event_rehearsals (id, event_id, date, start_time, duration_min, location, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(rid, id, r.date, r.startTime, r.durationMin, r.location ?? null, r.note ?? null);
    audit(db, c.sub, "create", "rehearsal", rid, r);
    return reply.code(201).send({ id: rid });
  });

  api.delete("/events/:id/rehearsals/:rid", async (req, reply) => {
    const c = caller(req);
    if (!isStaff(c)) return forbidden(reply);
    const { rid } = req.params as { id: string; rid: string };
    const res = db.prepare("DELETE FROM school_event_rehearsals WHERE id = ?").run(rid);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });
}
