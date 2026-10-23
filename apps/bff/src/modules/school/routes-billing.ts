import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit, now } from "./db.js";
import {
  generateInvoices,
  getSettings,
  guardianStudentIds,
  materializeLessons,
  periodRange,
  todayBerlin,
  uuid,
} from "./domain.js";
import { invoicePdf } from "./pdf.js";
import {
  type Caller,
  callerOf,
  forbidden,
  isAdmin,
  needRole,
  ownStudentId,
  type SchoolConfig,
} from "./scope.js";

const instrumentIn = z.object({
  name: z.string().min(1).max(200),
  category: z.string().max(100).nullish(),
  serialNo: z.string().max(100).nullish(),
  condition: z.string().max(200).nullish(),
  monthlyRateCents: z.number().int().min(0).default(0),
  notes: z.string().max(2000).nullish(),
});
const instrumentPatch = instrumentIn.partial().extend({
  status: z.enum(["available", "rented", "maintenance", "retired"]).optional(),
});

const rentalIn = z.object({
  instrumentId: z.string(),
  studentId: z.string(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  monthlyRateCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullish(),
});
const rentalPatch = z.object({
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  status: z.enum(["active", "returned"]).optional(),
  monthlyRateCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullish(),
});

const generateIn = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) });
const invoicePatch = z.object({
  status: z.enum(["draft", "issued", "paid", "cancelled"]).optional(),
  notes: z.string().max(2000).nullish(),
});
const lineIn = z.object({
  kind: z.enum(["flat", "lesson", "rental", "discount", "adjustment"]).default("adjustment"),
  label: z.string().min(1).max(300),
  qty: z.number().default(1),
  unitCents: z.number().int(),
  amountCents: z.number().int().optional(),
});
const paymentIn = z.object({
  amountCents: z.number().int().min(1),
  method: z.string().max(50).nullish(),
  note: z.string().max(500).nullish(),
  paidAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Household ids whose invoices the caller may read. */
function visibleHouseholdIds(db: DatabaseSync, c: Caller): Set<string> | "all" {
  if (isAdmin(c)) return "all";
  const ids = new Set<string>();
  if (c.person) {
    const rows = db
      .prepare(
        `SELECT DISTINCT m1.household_id AS id FROM school_household_members m1
         WHERE m1.person_id = ?`,
      )
      .all(c.person.id) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }
  for (const sid of guardianStudentIds(db, c.sub)) {
    const rows = db
      .prepare("SELECT household_id AS id FROM school_household_members WHERE person_id = ?")
      .all(sid) as { id: string }[];
    for (const r of rows) ids.add(r.id);
  }
  return ids;
}

function invoiceOut(db: DatabaseSync, id: string) {
  const inv = db
    .prepare(
      `SELECT i.*, h.name AS householdName FROM school_invoices i
       JOIN school_households h ON h.id = i.household_id WHERE i.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!inv) return null;
  const lines = db
    .prepare(
      `SELECT id, kind, label, qty, unit_cents AS unitCents, amount_cents AS amountCents, ref_id AS refId
       FROM school_invoice_lines WHERE invoice_id = ? ORDER BY rowid`,
    )
    .all(id);
  const payments = db
    .prepare(
      `SELECT id, paid_at AS paidAt, amount_cents AS amountCents, method, note
       FROM school_payments WHERE invoice_id = ? ORDER BY paid_at`,
    )
    .all(id);
  return {
    id: inv.id,
    householdId: inv.household_id,
    householdName: inv.householdName,
    period: inv.period,
    number: inv.number,
    status: inv.status,
    totalCents: inv.total_cents,
    issuedAt: inv.issued_at,
    dueDate: inv.due_date,
    notes: inv.notes,
    createdAt: inv.created_at,
    lines,
    payments,
    paidCents: (payments as { amountCents: number }[]).reduce((s, p) => s + p.amountCents, 0),
  };
}

export function registerBillingRoutes(
  api: FastifyInstance,
  db: DatabaseSync,
  cfg: SchoolConfig,
): void {
  const caller = (req: FastifyRequest) => callerOf(db, req, cfg);

  /* ------------------------------------------------------------ instruments */

  api.get("/instruments", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT i.id, i.name, i.category, i.serial_no AS serialNo, i.condition, i.status,
                i.monthly_rate_cents AS monthlyRateCents, i.notes,
                r.id AS rentalId, r.student_id AS studentId, r.start_date AS rentalStart,
                r.end_date AS rentalEnd, p.name AS studentName
         FROM school_instruments i
         LEFT JOIN school_rentals r ON r.instrument_id = i.id AND r.status = 'active'
         LEFT JOIN school_persons p ON p.id = r.student_id
         ORDER BY i.name`,
      )
      .all() as Record<string, unknown>[];
    const scoped = rows.map((r) => ({ ...r }));
    if (!isAdmin(c)) {
      const mine = new Set<string>([
        ...(ownStudentId(c) ? [ownStudentId(c) as string] : []),
        ...guardianStudentIds(db, c.sub),
      ]);
      return {
        instruments: scoped
          .filter(
            (r) => !r.studentId || mine.has(String(r.studentId)) || c.roles.includes("teacher"),
          )
          .map((r) =>
            mine.has(String(r.studentId)) || c.roles.includes("teacher")
              ? r
              : { ...r, studentName: undefined, studentId: undefined, rentalId: undefined },
          ),
      };
    }
    return { instruments: scoped, today: todayBerlin() };
  });

  api.post("/instruments", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = instrumentIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const i = parsed.data;
    const id = uuid();
    db.prepare(
      `INSERT INTO school_instruments (id, name, category, serial_no, condition, monthly_rate_cents, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      i.name,
      i.category ?? null,
      i.serialNo ?? null,
      i.condition ?? null,
      i.monthlyRateCents,
      i.notes ?? null,
      now(),
    );
    audit(db, c.sub, "create", "instrument", id, i);
    return reply.code(201).send({ id });
  });

  api.patch("/instruments/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = instrumentPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const i = parsed.data;
    const fields: Record<string, SQLInputValue | undefined> = {
      name: i.name,
      category: i.category,
      serial_no: i.serialNo,
      condition: i.condition,
      status: i.status,
      monthly_rate_cents: i.monthlyRateCents,
      notes: i.notes,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    const res = db
      .prepare(`UPDATE school_instruments SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args, id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "update", "instrument", id, i);
    return { ok: true };
  });

  api.delete("/instruments/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const active = db
      .prepare("SELECT 1 FROM school_rentals WHERE instrument_id = ? AND status = 'active'")
      .get(id);
    if (active) return reply.code(409).send({ error: "instrument has active rental" });
    const res = db.prepare("DELETE FROM school_instruments WHERE id = ?").run(id);
    if (Number(res.changes) === 0) return reply.code(404).send({ error: "not found" });
    audit(db, c.sub, "delete", "instrument", id);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- rentals */

  api.get("/rentals", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const rows = db
      .prepare(
        `SELECT r.id, r.instrument_id AS instrumentId, i.name AS instrumentName,
                r.student_id AS studentId, p.name AS studentName,
                r.start_date AS startDate, r.end_date AS endDate,
                r.monthly_rate_cents AS monthlyRateCents, r.status, r.notes
         FROM school_rentals r
         JOIN school_instruments i ON i.id = r.instrument_id
         JOIN school_persons p ON p.id = r.student_id
         ORDER BY r.status, r.start_date DESC`,
      )
      .all() as Record<string, unknown>[];
    if (isAdmin(c)) return { rentals: rows, today: todayBerlin() };
    const mine = new Set<string>([
      ...(ownStudentId(c) ? [ownStudentId(c) as string] : []),
      ...guardianStudentIds(db, c.sub),
    ]);
    return {
      rentals: rows
        .filter((r) => mine.has(String(r.studentId)) || c.roles.includes("teacher"))
        .map((r) =>
          mine.has(String(r.studentId)) || c.roles.includes("teacher")
            ? r
            : { ...r, studentName: undefined },
        ),
      today: todayBerlin(),
    };
  });

  api.post("/rentals", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = rentalIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const r = parsed.data;
    const inst = db
      .prepare("SELECT monthly_rate_cents AS rate FROM school_instruments WHERE id = ?")
      .get(r.instrumentId) as { rate: number } | undefined;
    if (!inst) return reply.code(404).send({ error: "instrument not found" });
    const id = uuid();
    db.prepare(
      `INSERT INTO school_rentals
         (id, instrument_id, student_id, start_date, end_date, monthly_rate_cents, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      id,
      r.instrumentId,
      r.studentId,
      r.startDate,
      r.endDate ?? null,
      r.monthlyRateCents ?? inst.rate,
      r.notes ?? null,
      now(),
    );
    db.prepare("UPDATE school_instruments SET status = 'rented' WHERE id = ?").run(r.instrumentId);
    audit(db, c.sub, "create", "rental", id, r);
    return reply.code(201).send({ id });
  });

  api.patch("/rentals/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = rentalPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const r = parsed.data;
    const existing = db
      .prepare("SELECT instrument_id AS iid, status FROM school_rentals WHERE id = ?")
      .get(id) as { iid: string; status: string } | undefined;
    if (!existing) return reply.code(404).send({ error: "not found" });
    const fields: Record<string, SQLInputValue | undefined> = {
      end_date: r.endDate,
      status: r.status,
      monthly_rate_cents: r.monthlyRateCents,
      notes: r.notes,
    };
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length > 0) {
      db.prepare(`UPDATE school_rentals SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    }
    if (r.status === "returned") {
      db.prepare("UPDATE school_instruments SET status = 'available' WHERE id = ?").run(
        existing.iid,
      );
    }
    audit(db, c.sub, "update", "rental", id, r);
    return { ok: true };
  });

  /* ---------------------------------------------------------------- invoices */

  api.post("/invoices/generate", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const parsed = generateIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    materializePeriod(db, parsed.data.period);
    const result = generateInvoices(db, parsed.data.period);
    audit(db, c.sub, "generate", "invoices", parsed.data.period, result);
    return result;
  });

  api.get("/invoices", async (req, reply) => {
    const c = caller(req);
    if (c.roles.length === 0) return forbidden(reply);
    const scope = visibleHouseholdIds(db, c);
    if (scope !== "all" && scope.size === 0) return { invoices: [] };
    const q = req.query as { period?: string; status?: string };
    let sql = `SELECT i.id, i.household_id AS householdId, h.name AS householdName, i.period,
                      i.number, i.status, i.total_cents AS totalCents, i.issued_at AS issuedAt,
                      i.due_date AS dueDate
               FROM school_invoices i JOIN school_households h ON h.id = i.household_id`;
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (scope !== "all") {
      where.push(`i.household_id IN (${[...scope].map(() => "?").join(",")})`);
      args.push(...scope);
    }
    if (q.period) {
      where.push("i.period = ?");
      args.push(q.period);
    }
    if (q.status) {
      where.push("i.status = ?");
      args.push(q.status);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    return {
      invoices: db.prepare(`${sql} ORDER BY i.period DESC, i.number`).all(...args),
    };
  });

  api.get("/invoices.csv", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const q = req.query as { period?: string };
    let sql = `SELECT i.number, i.period, i.status, i.total_cents AS total, i.issued_at AS issued,
                      i.due_date AS due, h.name AS household
               FROM school_invoices i JOIN school_households h ON h.id = i.household_id`;
    const args: SQLInputValue[] = [];
    if (q.period) {
      sql += " WHERE i.period = ?";
      args.push(q.period);
    }
    const rows = db.prepare(`${sql} ORDER BY i.number`).all(...args) as Record<string, unknown>[];
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const csv = [
      "number;period;status;total_cents;issued;due;household",
      ...rows.map((r) =>
        [r.number, r.period, r.status, r.total, r.issued, r.due, r.household].map(esc).join(";"),
      ),
    ].join("\r\n");
    return reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="invoices${q.period ? `-${q.period}` : ""}.csv"`,
      )
      .send(`﻿${csv}`);
  });

  api.get("/invoices/:id", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const scope = visibleHouseholdIds(db, c);
    const inv = invoiceOut(db, id);
    if (!inv) return reply.code(404).send({ error: "not found" });
    if (scope !== "all" && !scope.has(String(inv.householdId))) return forbidden(reply);
    return { invoice: inv };
  });

  api.patch("/invoices/:id", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = invoicePatch.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const existing = invoiceOut(db, id);
    if (!existing) return reply.code(404).send({ error: "not found" });
    const settings = getSettings(db);
    const fields: Record<string, SQLInputValue | undefined> = { status: p.status, notes: p.notes };
    if (p.status === "issued") {
      fields.issued_at = now();
      fields.due_date = new Date(Date.now() + settings.invoiceDueDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    const sets = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = ?`);
    const args = Object.values(fields).filter((v): v is SQLInputValue => v !== undefined);
    if (sets.length === 0) return reply.code(400).send({ error: "no fields" });
    sets.push("updated_at = ?");
    db.prepare(`UPDATE school_invoices SET ${sets.join(", ")} WHERE id = ?`).run(
      ...args,
      now(),
      id,
    );
    audit(db, c.sub, "update", "invoice", id, p);
    return { ok: true };
  });

  api.post("/invoices/:id/lines", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = lineIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const l = parsed.data;
    const inv = invoiceOut(db, id);
    if (!inv) return reply.code(404).send({ error: "not found" });
    if (inv.status !== "draft") return reply.code(409).send({ error: "only drafts are editable" });
    const amount = l.amountCents ?? Math.round(l.qty * l.unitCents);
    db.prepare(
      `INSERT INTO school_invoice_lines (id, invoice_id, kind, label, qty, unit_cents, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuid(), id, l.kind, l.label, l.qty, l.unitCents, amount);
    db.prepare(
      `UPDATE school_invoices
       SET total_cents = (SELECT COALESCE(SUM(amount_cents),0) FROM school_invoice_lines WHERE invoice_id = ?),
           updated_at = ?
       WHERE id = ?`,
    ).run(id, now(), id);
    audit(db, c.sub, "add_line", "invoice", id, l);
    return { ok: true };
  });

  api.post("/invoices/:id/payments", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const id = (req.params as { id: string }).id;
    const parsed = paymentIn.safeParse(req.body);
    if (!parsed.success) return reply.code(422).send({ error: parsed.error.issues });
    const p = parsed.data;
    const inv = invoiceOut(db, id);
    if (!inv) return reply.code(404).send({ error: "not found" });
    const pid = uuid();
    db.prepare(
      "INSERT INTO school_payments (id, invoice_id, paid_at, amount_cents, method, note) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(pid, id, p.paidAt ?? todayBerlin(), p.amountCents, p.method ?? null, p.note ?? null);
    const paid = inv.paidCents + p.amountCents;
    if (paid >= Number(inv.totalCents) && inv.status !== "cancelled") {
      db.prepare("UPDATE school_invoices SET status = 'paid', updated_at = ? WHERE id = ?").run(
        now(),
        id,
      );
    }
    audit(db, c.sub, "payment", "invoice", id, p);
    return { ok: true, id: pid, paidCents: paid };
  });

  api.get("/invoices/:id/pdf", async (req, reply) => {
    const c = caller(req);
    const id = (req.params as { id: string }).id;
    const inv = invoiceOut(db, id);
    if (!inv) return reply.code(404).send({ error: "not found" });
    const scope = visibleHouseholdIds(db, c);
    if (scope !== "all" && !scope.has(String(inv.householdId))) return forbidden(reply);
    const settings = getSettings(db);
    const hh = db
      .prepare("SELECT name, address FROM school_households WHERE id = ?")
      .get(String(inv.householdId)) as { name: string; address: string | null } | undefined;
    const pdf = invoicePdf({
      number: String(inv.number),
      period: String(inv.period),
      status: String(inv.status),
      issuedAt: inv.issuedAt as string | null,
      dueDate: inv.dueDate as string | null,
      schoolName: settings.schoolName,
      schoolAddress: settings.schoolAddress,
      householdName: hh?.name ?? "",
      householdAddress: hh?.address ?? null,
      lines: (
        inv.lines as { label: string; qty: number; unitCents: number; amountCents: number }[]
      ).map((l) => ({
        label: l.label,
        qty: l.qty,
        unitCents: l.unitCents,
        amountCents: l.amountCents,
      })),
      totalCents: Number(inv.totalCents),
      paidCents: Number(inv.paidCents),
      currency: settings.currency,
    });
    audit(db, c.sub, "read", "invoice_pdf", id);
    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `inline; filename="${inv.number}.pdf"`)
      .send(pdf);
  });

  /* ---------------------------------------------------------------- reports */

  api.get("/reports/attendance", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin", "teacher")) return;
    const q = req.query as { from?: string; to?: string };
    const { from, to } =
      q.from && q.to ? { from: q.from, to: q.to } : periodRange(todayBerlin().slice(0, 7));
    const own = c.person?.kind === "teacher" && !isAdmin(c) ? c.person.id : null;
    const rows = db
      .prepare(
        `SELECT p.name AS student, p.id AS studentId, ls.attendance AS att, COUNT(*) AS n
         FROM school_lesson_students ls
         JOIN school_lessons l ON l.id = ls.lesson_id
         JOIN school_persons p ON p.id = ls.student_id
         WHERE l.date >= ? AND l.date <= ? ${own ? "AND l.teacher_id = ?" : ""}
         GROUP BY ls.student_id, ls.attendance`,
      )
      .all(...(own ? [from, to, own] : [from, to])) as {
      student: string;
      studentId: string;
      att: string | null;
      n: number;
    }[];
    const byStudent = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const cur = (byStudent.get(r.studentId) ?? {
        studentId: r.studentId,
        student: r.student,
        attended: 0,
        absent_excused: 0,
        absent_unexcused: 0,
        unmarked: 0,
      }) as Record<string, number | string>;
      const key = r.att ?? "unmarked";
      cur[key] = (cur[key] as number) + r.n;
      byStudent.set(r.studentId, cur);
    }
    return { from, to, rows: [...byStudent.values()] };
  });

  api.get("/reports/revenue", async (req, reply) => {
    const c = caller(req);
    if (!needRole(c, reply, "admin")) return;
    const rows = db
      .prepare(
        `SELECT period, status, COUNT(*) AS count, SUM(total_cents) AS total
         FROM school_invoices GROUP BY period, status ORDER BY period DESC`,
      )
      .all() as { period: string; status: string; count: number; total: number | null }[];
    const paid = db
      .prepare(
        `SELECT substr(paid_at, 1, 7) AS period, SUM(amount_cents) AS total
         FROM school_payments GROUP BY period ORDER BY period DESC`,
      )
      .all() as { period: string; total: number | null }[];
    return { invoices: rows, payments: paid };
  });
}

/** Make sure series inside a billing period are materialized before invoicing. */
function materializePeriod(db: DatabaseSync, period: string) {
  const { from, to } = periodRange(period);
  materializeLessons(db, from, to);
}
