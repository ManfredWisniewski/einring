import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, mapRow, now, PERSON_MAP, type Person } from "./db.js";
import {
  allowedPeerSubs,
  generateInvoices,
  getSettings,
  guardianStudentIds,
  householdMembers,
  parseCsv,
  putSettings,
  teacherStudentIds,
  uuid,
} from "./domain.js";
import {
  type Caller,
  callerOf,
  forbidden,
  isAdmin,
  isStaff,
  needRole,
  ownStudentId,
  type SchoolConfig,
} from "./scope.js";

const personIn = z.object({
  kind: z.enum(["student", "guardian", "teacher", "staff"]),
  name: z.string().min(1).max(200),
  email: z.string().max(200).nullish(),
  phone: z.string().max(50).nullish(),
  birthdate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  matrixId: z.string().max(200).nullish(),
  notes: z.string().max(4000).nullish(),
  billingMode: z.enum(["flat", "per_lesson", "per_scheduled", "none"]).optional(),
  flatCents: z.number().int().min(0).nullish(),
  lessonCents: z.number().int().min(0).nullish(),
});
const personPatch = personIn.partial();

const householdIn = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(1000).nullish(),
  iban: z.string().max(40).nullish(),
  discountPct: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(4000).nullish(),
});
const membersIn = z.object({
  members: z
    .array(z.object({ personId: z.string(), relation: z.enum(["guardian", "student"]) }))
    .max(50),
});

const linkIn = z.object({ sub: z.string().min(1).max(200) });

const settingsIn = z
  .object({
    invoicePrefix: z.string().min(1).max(10),
    invoiceDueDays: z.number().int().min(0).max(120),
    cancelNoticeHours: z.number().int().min(0).max(720),
    billAbsentExcused: z.boolean(),
    billCancelledParent: z.boolean(),
    schoolName: z.string().max(200),
    schoolAddress: z.string().max(1000),
    currency: z.string().max(10),
  })
  .partial();

const importIn = z.object({
  kind: z.enum(["persons", "instruments"]),
  csv: z.string().min(1).max(2_000_000),
});

/** Student ids the caller may inspect (empty set = none). */
export function visibleStudentIds(db: DatabaseSync, c: Caller): Set<string> | "all" {
  if (isAdmin(c)) return "all";
  const ids = new Set<string>();
  if (c.person?.kind === "teacher") {
    for (const id of teacherStudentIds(db, c.person.id)) ids.add(id);
  }
  for (const id of guardianStudentIds(db, c.sub)) ids.add(id);
  const own = ownStudentId(c);
  if (own) ids.add(own);
  return ids;
}

export function registerCoreRoutes(
  api: FastifyInstance,
  db: DatabaseSync,
  cfg: SchoolConfig,
): void {
  const caller = (req: FastifyRequest) => callerOf(db, req, cfg);

  api.get("/me", async (req) => {
    const c = caller(req);
    const peers = [...allowedPeerSubs(db, c.sub, c.roles, c.person?.id ?? null)];
    return { roles: c.roles, person: c.person, peers };
  });

  api.get("/users", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    return {
      users: db
        .prepare(
          `SELECT u.sub, u.name, u.email, u.last_seen AS lastSeen,
                  (SELECT p.id FROM school_persons p WHERE p.sub = u.sub) AS personId
           FROM school_users u ORDER BY u.last_seen DESC`,
        )
        .all(),
    };
  });

  /* ------------------------------------------------------------- persons */

  api.get("/persons", async (req, _reply) => {
    const c = caller(req);
    if (!isStaff(c)) {
      // parents/students: only their own household
      const q = req.query as { kind?: string };
      void q;
      const ids = visibleStudentIds(db, c);
      if (ids === "all") return { persons: [] };
      const own = c.person ? [c.person] : [];
      const students = [...ids]
        .map((id) =>
          mapRow<Person>(
            db.prepare("SELECT * FROM school_persons WHERE id = ?").get(id) as Record<
              string,
              unknown
            >,
            PERSON_MAP,
          ),
        )
        .filter((p) => p.id !== c.person?.id);
      return { persons: [...own, ...students] };
    }
    const q = req.query as { kind?: string; search?: string };
    let sql = "SELECT * FROM school_persons WHERE deleted_at IS NULL";
    const args: SQLInputValue[] = [];
    if (q.kind) {
      sql += " AND kind = ?";
      args.push(q.kind);
    }
    if (q.search) {
      sql += " AND (name LIKE ? OR email LIKE ?)";
      args.push(`%${q.search}%`, `%${q.search}%`);
    }
    // Teachers only get students they teach + staff — enforced below via filter
    let rows = (db.prepare(`${sql} ORDER BY name`).all(...args) as Record<string, unknown>[]).map(
      (r) => mapRow<Person>(r, PERSON_MAP),
    );
    if (!isAdmin(c) && c.person?.kind === "teacher") {
      const mine = teacherStudentIds(db, c.person.id);
      rows = rows.filter((p) =>
        p.id === c.person?.id || mine.has(p.id) || p.kind !== "student"
          ? mine.has(p.id) || p.id === c.person?.id
          : false,
      );
    }
    return { persons: rows };
  });

  api.post("/persons", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = personIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO school_persons
         (id, kind, name, email, phone, birthdate, matrix_id, notes,
          billing_mode, flat_cents, lesson_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      p.kind,
      p.name,
      p.email ?? null,
      p.phone ?? null,
      p.birthdate ?? null,
      p.matrixId ?? null,
      p.notes ?? null,
      p.billingMode ?? "none",
      p.flatCents ?? null,
      p.lessonCents ?? null,
      ts,
      ts,
    );
    audit(db, c.sub, "create", "person", id, { name: p.name, kind: p.kind });
    return reply.code(201).send({ id });
  });

  api.get("/persons/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const row = db
      .prepare("SELECT * FROM school_persons WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    const p = mapRow<Person>(row, PERSON_MAP);
    if (!isStaff(c)) {
      const ids = visibleStudentIds(db, c);
      if (ids !== "all" && p.id !== c.person?.id && !ids.has(p.id)) return forbidden(reply);
    } else if (!isAdmin(c) && c.person?.kind === "teacher") {
      if (p.id !== c.person.id && !teacherStudentIds(db, c.person.id).has(p.id)) {
        return forbidden(reply);
      }
    }
    const households = db
      .prepare(
        `SELECT h.id, h.name, m.relation FROM school_household_members m
         JOIN school_households h ON h.id = m.household_id WHERE m.person_id = ?`,
      )
      .all(id);
    return { person: p, households };
  });

  api.patch("/persons/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = personPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      kind: p.kind,
      name: p.name,
      email: p.email,
      phone: p.phone,
      birthdate: p.birthdate,
      matrix_id: p.matrixId,
      notes: p.notes,
      billing_mode: p.billingMode,
      flat_cents: p.flatCents,
      lesson_cents: p.lessonCents,
      active: p.email === undefined ? undefined : undefined, // placeholder, see below
    };
    delete fields.active;
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(v === null ? null : v);
    }
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    sets.push("updated_at = ?");
    args.push(now(), id);
    const res = db
      .prepare(`UPDATE school_persons SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`)
      .run(...args);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "update", "person", id, p);
    return { ok: true };
  });

  /** GDPR anonymization: profile scrubbed, financial/attendance records kept (D56). */
  api.delete("/persons/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const ts = now();
    const res = db
      .prepare(
        `UPDATE school_persons
         SET name = 'Person-' || substr(id, 1, 8), sub = NULL, email = NULL, phone = NULL,
             birthdate = NULL, matrix_id = NULL, notes = NULL, active = 0,
             deleted_at = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(ts, ts, id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    db.prepare("DELETE FROM school_household_members WHERE person_id = ?").run(id);
    audit(db, c.sub, "anonymize", "person", id);
    return { ok: true };
  });

  api.post("/persons/:id/link", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = linkIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const res = db
      .prepare(
        "UPDATE school_persons SET sub = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      )
      .run(parsed.data.sub, now(), id);
    if (Number(res.changes) === 0) {
      const exists = db.prepare("SELECT 1 FROM school_persons WHERE id = ?").get(id);
      return reply.code(exists ? 409 : 404).send({ error: "sub already linked or not found" });
    }
    audit(db, c.sub, "link", "person", id, { sub: parsed.data.sub });
    return { ok: true };
  });

  /** GDPR export: everything stored about the person. */
  api.get("/persons/:id/export", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const self = c.person?.id === id;
    const guardian = [...guardianStudentIds(db, c.sub)].includes(id);
    if (!isAdmin(c) && !self && !guardian) return forbidden(reply);
    const p = db.prepare("SELECT * FROM school_persons WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!p) return reply.code(404).send({ error: "not found" });
    const q = (sql: string, ...a: SQLInputValue[]) => db.prepare(sql).all(...a);
    return {
      person: p,
      households: q(
        `SELECT h.*, m.relation FROM school_household_members m
         JOIN school_households h ON h.id = m.household_id WHERE m.person_id = ?`,
        id,
      ),
      attendance: q(
        `SELECT l.date, l.start_time, l.duration_min, ls.attendance, ls.public_note, ls.practice
         FROM school_lesson_students ls JOIN school_lessons l ON l.id = ls.lesson_id
         WHERE ls.student_id = ? ORDER BY l.date`,
        id,
      ),
      rentals: q("SELECT * FROM school_rentals WHERE student_id = ?", id),
      events: q("SELECT * FROM school_event_participants WHERE student_id = ?", id),
      consents: q("SELECT * FROM school_consents WHERE person_id = ?", id),
      makeupRequests: q("SELECT * FROM school_makeup_requests WHERE student_id = ?", id),
      exportedAt: now(),
    };
  });

  /* ---------------------------------------------------------- households */

  api.get("/households", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher", "parent")) return;
    if (isAdmin(c)) {
      const rows = db.prepare("SELECT * FROM school_households ORDER BY name").all() as Record<
        string,
        unknown
      >[];
      return {
        households: rows.map((h) => ({ ...h, members: householdMembers(db, String(h.id)) })),
      };
    }
    if (c.person) {
      const rows = db
        .prepare(
          `SELECT h.* FROM school_households h
           JOIN school_household_members m ON m.household_id = h.id WHERE m.person_id = ?`,
        )
        .all(c.person.id) as Record<string, unknown>[];
      return {
        households: rows.map((h) => ({ ...h, members: householdMembers(db, String(h.id)) })),
      };
    }
    return { households: [] };
  });

  api.post("/households", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = householdIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const h = parsed.data;
    const id = uuid();
    const ts = now();
    db.prepare(
      `INSERT INTO school_households (id, name, address, iban, discount_pct, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      h.name,
      h.address ?? null,
      h.iban ?? null,
      h.discountPct ?? 0,
      h.notes ?? null,
      ts,
      ts,
    );
    audit(db, c.sub, "create", "household", id, { name: h.name });
    return reply.code(201).send({ id });
  });

  api.patch("/households/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = householdIn.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const h = parsed.data;
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const fields: Record<string, SQLInputValue | undefined> = {
      name: h.name,
      address: h.address,
      iban: h.iban,
      discount_pct: h.discountPct,
      notes: h.notes,
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(v);
    }
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    sets.push("updated_at = ?");
    args.push(now(), id);
    const res = db
      .prepare(`UPDATE school_households SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "update", "household", id, h);
    return { ok: true };
  });

  api.delete("/households/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    db.prepare("DELETE FROM school_household_members WHERE household_id = ?").run(id);
    const res = db.prepare("DELETE FROM school_households WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "delete", "household", id);
    return { ok: true };
  });

  /** Replaces the household's member set atomically. */
  api.put("/households/:id/members", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    if (!db.prepare("SELECT 1 FROM school_households WHERE id = ?").get(id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const parsed = membersIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    for (const m of parsed.data.members) {
      if (
        !db
          .prepare("SELECT 1 FROM school_persons WHERE id = ? AND deleted_at IS NULL")
          .get(m.personId)
      ) {
        return reply.code(422).send({ error: `unknown person ${m.personId}` });
      }
    }
    db.prepare("DELETE FROM school_household_members WHERE household_id = ?").run(id);
    const ins = db.prepare(
      "INSERT INTO school_household_members (household_id, person_id, relation) VALUES (?, ?, ?)",
    );
    for (const m of parsed.data.members) ins.run(id, m.personId, m.relation);
    audit(db, c.sub, "update", "household_members", id, parsed.data.members);
    return { ok: true };
  });

  /* ------------------------------------------------------------ settings */

  api.get("/settings", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    return { settings: getSettings(db) };
  });

  api.put("/settings", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = settingsIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const settings = putSettings(db, parsed.data);
    audit(db, c.sub, "update", "settings", null, parsed.data);
    return { settings };
  });

  /* --------------------------------------------------------------- audit */

  api.get("/audit", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const q = req.query as { entity?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    let sql = "SELECT * FROM school_audit";
    const args: SQLInputValue[] = [];
    if (q.entity) {
      sql += " WHERE entity = ?";
      args.push(q.entity);
    }
    return {
      entries: db
        .prepare(`${sql} ORDER BY id DESC LIMIT ?`)
        .all(...args, limit)
        .map((r) => {
          const row = r as Record<string, unknown>;
          return {
            id: row.id,
            sub: row.sub,
            action: row.action,
            entity: row.entity,
            entityId: row.entity_id,
            detail: row.detail,
            at: row.at,
          };
        }),
    };
  });

  /* --------------------------------------------------------------- import */

  api.post("/import/csv", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = importIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const rows = parseCsv(parsed.data.csv);
    if (rows.length < 2) return reply.code(422).send({ error: "csv needs a header + data row" });
    const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const col = (...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    };
    let created = 0;
    const errors: string[] = [];
    if (parsed.data.kind === "persons") {
      const iName = col("name");
      const iKind = col("kind", "type");
      const iEmail = col("email", "e-mail");
      const iPhone = col("phone", "tel");
      const iBirth = col("birthdate", "dob");
      const iBilling = col("billing", "billing_mode");
      if (iName < 0) return reply.code(422).send({ error: "missing 'name' column" });
      for (const [i, r] of rows.slice(1).entries()) {
        const name = r[iName]?.trim();
        if (!name) {
          errors.push(`row ${i + 2}: empty name`);
          continue;
        }
        const kind = (r[iKind]?.trim() || "student") as Person["kind"];
        if (!["student", "guardian", "teacher", "staff"].includes(kind)) {
          errors.push(`row ${i + 2}: bad kind '${kind}'`);
          continue;
        }
        const id = uuid();
        const ts = now();
        db.prepare(
          `INSERT INTO school_persons (id, kind, name, email, phone, birthdate, billing_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          kind,
          name,
          r[iEmail]?.trim() || null,
          iPhone >= 0 ? r[iPhone]?.trim() || null : null,
          iBirth >= 0 ? r[iBirth]?.trim() || null : null,
          iBilling >= 0 ? r[iBilling]?.trim() || "none" : "none",
          ts,
          ts,
        );
        created++;
      }
    } else {
      const iName = col("name");
      const iSerial = col("serial", "serial_no", "serialno");
      const iCat = col("category");
      const iRate = col("rate", "monthly_rate", "monthly_rate_cents");
      if (iName < 0) return reply.code(422).send({ error: "missing 'name' column" });
      for (const r of rows.slice(1)) {
        const name = r[iName]?.trim();
        if (!name) continue;
        const rate = iRate >= 0 ? Math.round(Number(r[iRate]) || 0) : 0;
        db.prepare(
          `INSERT INTO school_instruments (id, name, category, serial_no, monthly_rate_cents, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          uuid(),
          name,
          iCat >= 0 ? r[iCat]?.trim() || null : null,
          iSerial >= 0 ? r[iSerial]?.trim() || null : null,
          rate,
          now(),
        );
        created++;
      }
    }
    audit(db, c.sub, "import", parsed.data.kind, null, { created, errors: errors.length });
    return { created, errors };
  });

  /* ----------------------------------------------------------------- seed */

  api.post("/seed", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    if (!cfg.SEED) return reply.code(403).send({ error: "MODULE_SCHOOL_SEED not set" });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM school_persons").get() as { n: number }).n;
    if (count > 0) return reply.code(409).send({ error: "not empty" });
    const ts = now();
    const person = (
      kind: string,
      name: string,
      billingMode = "none",
      flat: number | null = null,
    ) => {
      const id = uuid();
      db.prepare(
        `INSERT INTO school_persons (id, kind, name, billing_mode, flat_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, kind, name, billingMode, flat, ts, ts);
      return id;
    };
    const t1 = person("teacher", "Person-1001");
    person("teacher", "Person-1002");
    const hh = uuid();
    db.prepare(
      "INSERT INTO school_households (id, name, discount_pct, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    ).run(hh, "Household-01", ts, ts);
    const s1 = person("student", "Person-2001", "flat", 8000);
    const s2 = person("student", "Person-2002", "per_lesson");
    const g1 = person("guardian", "Person-3001");
    const mem = db.prepare(
      "INSERT INTO school_household_members (household_id, person_id, relation) VALUES (?, ?, ?)",
    );
    mem.run(hh, s1, "student");
    mem.run(hh, s2, "student");
    mem.run(hh, g1, "guardian");
    const lt = uuid();
    db.prepare(
      "INSERT INTO school_lesson_types (id, name, duration_min, default_rate_cents) VALUES (?, ?, 45, 3500)",
    ).run(lt, "Einzelunterricht");
    const series = uuid();
    db.prepare(
      `INSERT INTO school_lesson_series (id, teacher_id, lesson_type_id, weekday, start_time, duration_min, valid_from, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(series, t1, lt, 1, "15:00", 45, "2025-09-01", ts, ts);
    const ss = db.prepare(
      "INSERT INTO school_series_students (series_id, student_id) VALUES (?, ?)",
    );
    ss.run(series, s1);
    ss.run(series, s2);
    const inst = uuid();
    db.prepare(
      "INSERT INTO school_instruments (id, name, category, serial_no, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(inst, "Klavier Yamaha U1", "Klavier", "SN-0001", 3000, ts);
    db.prepare(
      "INSERT INTO school_rentals (id, instrument_id, student_id, start_date, monthly_rate_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(uuid(), inst, s2, "2025-09-01", 3000, ts);
    db.prepare(
      "INSERT INTO school_holidays (id, name, start_date, end_date) VALUES (?, ?, ?, ?)",
    ).run(uuid(), "Herbstferien", "2026-10-12", "2026-10-24");
    audit(db, c.sub, "seed", "school", null);
    return { ok: true };
  });
}

export { generateInvoices };
