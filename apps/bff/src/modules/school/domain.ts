import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Fetch } from "../../nextcloud/client.js";
import {
  type Household,
  LESSON_MAP,
  type Lesson,
  mapRow,
  now,
  PERSON_MAP,
  type Person,
  type Role,
  SERIES_MAP,
  type Series,
} from "./db.js";

/* ------------------------------------------------------------------ dates */

export const uuid = () => randomUUID();

const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today in Europe/Berlin as `YYYY-MM-DD`. */
export const todayBerlin = () => berlinDate.format(new Date());

/** Local weekday 0=Sunday..6=Saturday for a `YYYY-MM-DD` (UTC-noon avoids TZ edge cases). */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** `HH:MM` → minutes since midnight. */
export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

/** `YYYY-MM-DD` bounds of a `YYYY-MM` period. */
export function periodRange(period: string): { from: string; to: string } {
  const from = `${period}-01`;
  const [y, m] = period.split("-").map(Number);
  const next =
    m === 12 ? `${(y ?? 0) + 1}-01-01` : `${y}-${String((m ?? 0) + 1).padStart(2, "0")}-01`;
  return { from, to: addDays(next, -1) };
}

/* ------------------------------------------------------------- materialize */

const SERIES_COLS = `id, series_id, teacher_id, substitute_teacher_id, lesson_type_id, date,
  start_time, duration_min, location, status, cancel_reason, is_makeup, makeup_for_lesson_id,
  override_conflicts, notes, created_at, updated_at`;

export function getSeries(db: DatabaseSync, id: string): Series | undefined {
  const row = db
    .prepare("SELECT * FROM school_lesson_series WHERE id = ? AND deleted_at IS NULL")
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRow<Series>(row, SERIES_MAP) : undefined;
}

/**
 * Materializes series occurrences into `school_lessons` for [from,to].
 * Holidays/closures are skipped; a teacher absence does NOT skip (the lesson
 * exists and can be substituted or cancelled). Idempotent via UNIQUE(series_id,date).
 */
export function materializeLessons(db: DatabaseSync, from: string, to: string): void {
  const series = db
    .prepare(
      `SELECT * FROM school_lesson_series
       WHERE deleted_at IS NULL AND valid_from <= ? AND (valid_until IS NULL OR valid_until >= ?)`,
    )
    .all(to, from) as Record<string, unknown>[];
  if (series.length === 0) return;
  const holidays = db
    .prepare(`SELECT start_date AS s, end_date AS e FROM school_holidays`)
    .all() as { s: string; e: string }[];
  const studentsOf = db.prepare(
    "SELECT student_id FROM school_series_students WHERE series_id = ?",
  );
  const insert = db.prepare(
    `INSERT INTO school_lessons
       (id, series_id, teacher_id, lesson_type_id, date, start_time, duration_min, location,
        status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
     ON CONFLICT(series_id, date) DO NOTHING`,
  );
  const insertStudent = db.prepare(
    "INSERT OR IGNORE INTO school_lesson_students (lesson_id, student_id) VALUES (?, ?)",
  );
  const lessonIdFor = db.prepare("SELECT id FROM school_lessons WHERE series_id = ? AND date = ?");
  const inHoliday = (d: string) => holidays.some((h) => d >= h.s && d <= h.e);

  for (const raw of series) {
    const s = mapRow<Series>(raw, SERIES_MAP);
    const students = (studentsOf.all(s.id) as { student_id: string }[]).map((r) => r.student_id);
    if (students.length === 0) continue;
    let d = from > s.validFrom ? from : s.validFrom;
    // advance to the series weekday
    while (weekdayOf(d) !== s.weekday) d = addDays(d, 1);
    const end = s.validUntil && s.validUntil < to ? s.validUntil : to;
    for (; d <= end; d = addDays(d, 7)) {
      if (inHoliday(d)) continue;
      const ts = now();
      const res = insert.run(
        uuid(),
        s.id,
        s.teacherId,
        s.lessonTypeId,
        d,
        s.startTime,
        s.durationMin,
        s.location,
        ts,
        ts,
      );
      // Students attach only on first materialization — re-inserting on existing
      // lessons would resurrect per-student exceptions. Backfilling newly added
      // series students into future lessons happens explicitly in the PATCH route.
      if (Number(res.changes) > 0) {
        const lid = (lessonIdFor.get(s.id, d) as { id: string } | undefined)?.id;
        if (lid) for (const st of students) insertStudent.run(lid, st);
      }
    }
  }
}

/* --------------------------------------------------------------- conflicts */

export interface Conflict {
  kind:
    | "teacher_double_booking"
    | "student_double_booking"
    | "teacher_absent"
    | "holiday"
    | "outside_availability";
  detail: string;
}

export function detectConflicts(
  db: DatabaseSync,
  input: {
    date: string;
    startMin: number;
    durationMin: number;
    teacherId: string;
    studentIds: string[];
    excludeLessonId?: string;
  },
): Conflict[] {
  const { date, startMin, durationMin, teacherId, studentIds, excludeLessonId } = input;
  const endMin = startMin + durationMin;
  const conflicts: Conflict[] = [];

  const sameDay = db
    .prepare(
      `SELECT ${SERIES_COLS} FROM school_lessons
       WHERE date = ? AND status = 'scheduled' AND id != ?`,
    )
    .all(date, excludeLessonId ?? "") as Record<string, unknown>[];
  const lessons = sameDay.map((r) => mapRow<Lesson>(r, LESSON_MAP));

  for (const l of lessons) {
    const s = toMin(l.startTime);
    if (!overlaps(startMin, endMin, s, s + l.durationMin)) continue;
    const effectiveTeacher = l.substituteTeacherId ?? l.teacherId;
    if (effectiveTeacher === teacherId) {
      conflicts.push({
        kind: "teacher_double_booking",
        detail: `teacher already has lesson ${l.id} on ${l.date} ${l.startTime}`,
      });
    }
    const ls = db
      .prepare("SELECT student_id FROM school_lesson_students WHERE lesson_id = ?")
      .all(l.id) as { student_id: string }[];
    for (const st of studentIds) {
      if (ls.some((r) => r.student_id === st)) {
        conflicts.push({
          kind: "student_double_booking",
          detail: `student ${st} already has lesson ${l.id} on ${l.date} ${l.startTime}`,
        });
      }
    }
  }

  const holiday = db
    .prepare("SELECT name FROM school_holidays WHERE start_date <= ? AND end_date >= ?")
    .get(date, date) as { name: string } | undefined;
  if (holiday) {
    conflicts.push({ kind: "holiday", detail: `${holiday.name} covers ${date}` });
  }

  const absence = db
    .prepare(
      `SELECT kind FROM school_teacher_absences
       WHERE teacher_id = ? AND start_date <= ? AND end_date >= ?`,
    )
    .get(teacherId, date, date) as { kind: string } | undefined;
  if (absence) {
    conflicts.push({
      kind: "teacher_absent",
      detail: `teacher ${absence.kind} covers ${date}`,
    });
  }

  // Only flag availability when the teacher has windows configured at all.
  const hasWindows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM school_teacher_availability
       WHERE teacher_id = ? AND valid_from <= ? AND (valid_until IS NULL OR valid_until >= ?)`,
    )
    .get(teacherId, date, date) as { n: number };
  if (hasWindows.n > 0) {
    const wd = weekdayOf(date);
    const windows = db
      .prepare(
        `SELECT start_time AS et_start, end_time AS et_end FROM school_teacher_availability
         WHERE teacher_id = ? AND weekday = ?
           AND valid_from <= ? AND (valid_until IS NULL OR valid_until >= ?)`,
      )
      .all(teacherId, wd, date, date) as { et_start: string; et_end: string }[];
    const inside = windows.some((w) => toMin(w.et_start) <= startMin && toMin(w.et_end) >= endMin);
    if (!inside) {
      conflicts.push({
        kind: "outside_availability",
        detail: `${date} ${startMin}–${endMin} not inside any availability window`,
      });
    }
  }
  return conflicts;
}

/* ----------------------------------------------------------------- billing */

export interface SchoolSettings {
  invoicePrefix: string;
  invoiceDueDays: number;
  cancelNoticeHours: number;
  billAbsentExcused: boolean;
  billCancelledParent: boolean;
  schoolName: string;
  schoolAddress: string;
  currency: string;
}

const DEFAULT_SETTINGS: SchoolSettings = {
  invoicePrefix: "RE",
  invoiceDueDays: 14,
  cancelNoticeHours: 24,
  billAbsentExcused: false,
  billCancelledParent: false,
  schoolName: "",
  schoolAddress: "",
  currency: "EUR",
};

export function getSettings(db: DatabaseSync): SchoolSettings {
  const rows = db.prepare("SELECT key, value FROM school_settings").all() as {
    key: string;
    value: string;
  }[];
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      merged[r.key ?? ""] = JSON.parse(r.value);
    } catch {
      /* keep default */
    }
  }
  return { ...DEFAULT_SETTINGS, ...(merged as Partial<SchoolSettings>) };
}

export function putSettings(db: DatabaseSync, patch: Partial<SchoolSettings>): SchoolSettings {
  const put = db.prepare(
    `INSERT INTO school_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  for (const [k, v] of Object.entries(patch)) put.run(k, JSON.stringify(v));
  return getSettings(db);
}

export function household(db: DatabaseSync, id: string): Household | undefined {
  const row = db.prepare("SELECT * FROM school_households WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row
    ? mapRow<Household>(row, {
        id: "id",
        name: "name",
        address: "address",
        iban: "iban",
        discount_pct: "discountPct",
        notes: "notes",
      })
    : undefined;
}

/** Students + guardians of a household, resolved to persons. */
export function householdMembers(
  db: DatabaseSync,
  householdId: string,
): { person: Person; relation: string }[] {
  const rows = db
    .prepare(
      `SELECT p.*, m.relation FROM school_household_members m
       JOIN school_persons p ON p.id = m.person_id
       WHERE m.household_id = ? AND p.deleted_at IS NULL`,
    )
    .all(householdId) as Record<string, unknown>[];
  return rows.map((r) => ({
    person: mapRow<Person>(r, PERSON_MAP),
    relation: String(r.relation),
  }));
}

/**
 * Generates one draft invoice per household for `period` (YYYY-MM).
 * Idempotent: households that already have an invoice for the period are skipped.
 */
export function generateInvoices(
  db: DatabaseSync,
  period: string,
): { created: number; skipped: number; invoiceIds: string[] } {
  const settings = getSettings(db);
  const { from, to } = periodRange(period);
  const households = db.prepare("SELECT * FROM school_households ORDER BY name").all() as Record<
    string,
    unknown
  >[];
  let created = 0;
  let skipped = 0;
  const invoiceIds: string[] = [];

  for (const raw of households) {
    const hh = mapRow<Household>(raw, {
      id: "id",
      name: "name",
      address: "address",
      iban: "iban",
      discount_pct: "discountPct",
      notes: "notes",
    });
    const exists = db
      .prepare("SELECT 1 FROM school_invoices WHERE household_id = ? AND period = ?")
      .get(hh.id, period);
    if (exists) {
      skipped++;
      continue;
    }
    const members = householdMembers(db, hh.id).filter((m) => m.relation === "student");
    const lines: {
      kind: string;
      label: string;
      qty: number;
      unitCents: number;
      amountCents: number;
      refId: string | null;
    }[] = [];

    for (const { person: st } of members) {
      if (st.billingMode === "flat" && st.flatCents) {
        lines.push({
          kind: "flat",
          label: `${st.name} — monthly fee ${period}`,
          qty: 1,
          unitCents: st.flatCents,
          amountCents: st.flatCents,
          refId: st.id,
        });
      } else if (st.billingMode === "per_lesson" || st.billingMode === "per_scheduled") {
        // Billable statuses per mode + settings.
        const rows = db
          .prepare(
            `SELECT l.id, l.date, l.start_time AS st, l.duration_min AS dur, lt.default_rate_cents AS rate,
                    ls.attendance AS att, l.status AS lstatus
             FROM school_lesson_students ls
             JOIN school_lessons l ON l.id = ls.lesson_id
             LEFT JOIN school_lesson_types lt ON lt.id = l.lesson_type_id
             WHERE ls.student_id = ? AND l.date >= ? AND l.date <= ?`,
          )
          .all(st.id, from, to) as {
          id: string;
          date: string;
          st: string;
          dur: number;
          rate: number | null;
          att: string | null;
          lstatus: string;
        }[];
        const billable = rows.filter((r) => {
          if (st.billingMode === "per_scheduled") return r.lstatus !== "cancelled_school";
          // per_lesson: attendance decides
          if (r.att === "attended") return true;
          if (r.att === "absent_unexcused") return true;
          if (r.att === "absent_excused") return settings.billAbsentExcused;
          if (r.lstatus === "cancelled_parent") return settings.billCancelledParent;
          return false;
        });
        const rate = st.lessonCents ?? null;
        const count = billable.length;
        if (count > 0) {
          const unit = rate ?? billable[0]?.rate ?? 0;
          lines.push({
            kind: "lesson",
            label:
              st.billingMode === "per_scheduled"
                ? `${st.name} — ${count} scheduled lesson(s) ${period}`
                : `${st.name} — ${count} billable lesson(s) ${period}`,
            qty: count,
            unitCents: unit,
            amountCents: count * unit,
            refId: st.id,
          });
        }
      }
      // Rentals for this student
      const rentals = db
        .prepare(
          `SELECT r.id, r.monthly_rate_cents AS rate, i.name AS iname
           FROM school_rentals r JOIN school_instruments i ON i.id = r.instrument_id
           WHERE r.student_id = ? AND r.status = 'active'
             AND r.start_date <= ? AND (r.end_date IS NULL OR r.end_date >= ?)`,
        )
        .all(st.id, to, from) as { id: string; rate: number; iname: string }[];
      for (const r of rentals) {
        lines.push({
          kind: "rental",
          label: `${st.name} — instrument rental ${r.iname} ${period}`,
          qty: 1,
          unitCents: r.rate,
          amountCents: r.rate,
          refId: r.id,
        });
      }
    }

    if (lines.length === 0) {
      skipped++;
      continue;
    }
    let total = lines.reduce((s, l) => s + l.amountCents, 0);
    if (hh.discountPct > 0) {
      const disc = -Math.round((total * hh.discountPct) / 100);
      lines.push({
        kind: "discount",
        label: `family discount ${hh.discountPct}%`,
        qty: 1,
        unitCents: disc,
        amountCents: disc,
        refId: null,
      });
      total += disc;
    }

    const ts = now();
    const id = uuid();
    const seq =
      ((
        db.prepare("SELECT COUNT(*) AS n FROM school_invoices WHERE period = ?").get(period) as {
          n: number;
        }
      ).n ?? 0) + 1;
    const number = `${settings.invoicePrefix}-${period.replace("-", "")}-${String(seq).padStart(3, "0")}`;
    db.prepare(
      `INSERT INTO school_invoices
         (id, household_id, period, number, status, total_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, hh.id, period, number, total, ts, ts);
    const put = db.prepare(
      `INSERT INTO school_invoice_lines
         (id, invoice_id, kind, label, qty, unit_cents, amount_cents, ref_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines)
      put.run(uuid(), id, l.kind, l.label, l.qty, l.unitCents, l.amountCents, l.refId);
    created++;
    invoiceIds.push(id);
  }
  return { created, skipped, invoiceIds };
}

/* ---------------------------------------------------------------- messaging */

/** Resolves an announcement audience into a set of subs (linked persons only). */
export function audienceSubs(db: DatabaseSync, audience: string): Set<string> {
  const kind =
    audience === "parents" ? "guardian" : audience === "teachers" ? "teacher" : "student";
  const where =
    audience === "all" ? "p.sub IS NOT NULL" : `p.sub IS NOT NULL AND p.kind = '${kind}'`;
  const rows = db
    .prepare(
      `SELECT p.sub AS sub FROM school_persons p
       WHERE p.deleted_at IS NULL AND p.active = 1 AND ${where}`,
    )
    .all() as { sub: string }[];
  return new Set(rows.map((r) => r.sub));
}

/** Student ids a teacher instructs (via series membership or lesson assignment). */
export function teacherStudentIds(db: DatabaseSync, teacherPersonId: string): Set<string> {
  const out = new Set<string>();
  const a = db
    .prepare(
      `SELECT DISTINCT ss.student_id AS id FROM school_series_students ss
       JOIN school_lesson_series s ON s.id = ss.series_id
       WHERE s.teacher_id = ? AND s.deleted_at IS NULL`,
    )
    .all(teacherPersonId) as { id: string }[];
  const b = db
    .prepare(
      `SELECT DISTINCT ls.student_id AS id FROM school_lesson_students ls
       JOIN school_lessons l ON l.id = ls.lesson_id
       WHERE l.teacher_id = ? OR l.substitute_teacher_id = ?`,
    )
    .all(teacherPersonId, teacherPersonId) as { id: string }[];
  for (const r of [...a, ...b]) out.add(r.id);
  return out;
}

/** Student ids visible to a guardian sub (students in their households). */
export function guardianStudentIds(db: DatabaseSync, guardianSub: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT m2.person_id AS id
       FROM school_persons g
       JOIN school_household_members m1 ON m1.person_id = g.id AND m1.relation = 'guardian'
       JOIN school_household_members m2 ON m2.household_id = m1.household_id AND m2.relation = 'student'
       WHERE g.sub = ? AND g.deleted_at IS NULL`,
    )
    .all(guardianSub) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Subs this caller may open a direct thread with. */
export function allowedPeerSubs(
  db: DatabaseSync,
  sub: string,
  roles: Role[],
  personId: string | null,
): Set<string> {
  const peers = new Set<string>();
  const allLinked = () =>
    (
      db
        .prepare(
          "SELECT sub FROM school_persons WHERE sub IS NOT NULL AND deleted_at IS NULL AND active = 1",
        )
        .all() as { sub: string }[]
    ).map((r) => r.sub);
  if (roles.includes("admin")) {
    for (const s of allLinked()) peers.add(s);
    return peers;
  }
  const addSubsOfPersons = (ids: Iterable<string>) => {
    for (const id of ids) {
      const rows = db
        .prepare("SELECT sub FROM school_persons WHERE id = ? AND sub IS NOT NULL")
        .all(id) as { sub: string }[];
      for (const r of rows) peers.add(r.sub);
      // + guardians in the same households
      const h = db
        .prepare(
          `SELECT m2.person_id AS pid FROM school_household_members m1
           JOIN school_household_members m2 ON m2.household_id = m1.household_id
           WHERE m1.person_id = ? AND m2.relation = 'guardian'`,
        )
        .all(id) as { pid: string }[];
      for (const g of h) {
        const s = db
          .prepare("SELECT sub FROM school_persons WHERE id = ? AND sub IS NOT NULL")
          .all(g.pid) as { sub: string }[];
        for (const r of s) peers.add(r.sub);
      }
    }
  };
  if (roles.includes("teacher") && personId) {
    addSubsOfPersons(teacherStudentIds(db, personId));
    // teachers may also reach admins + other teachers
    const staff = db
      .prepare(
        "SELECT sub FROM school_persons WHERE sub IS NOT NULL AND kind IN ('teacher','staff') AND deleted_at IS NULL",
      )
      .all() as { sub: string }[];
    for (const s of staff) peers.add(s.sub);
  }
  if (roles.includes("parent")) {
    addSubsOfPersons(guardianStudentIds(db, sub));
    // + teachers of their children + admins
    const studentIds = [...guardianStudentIds(db, sub)];
    for (const sid of studentIds) {
      const teachers = db
        .prepare(
          `SELECT DISTINCT p.sub AS sub FROM school_lessons l
           JOIN school_lesson_students ls ON ls.lesson_id = l.id
           JOIN school_persons p ON p.id = l.teacher_id
           WHERE ls.student_id = ? AND p.sub IS NOT NULL`,
        )
        .all(sid) as { sub: string }[];
      const seriesTeachers = db
        .prepare(
          `SELECT DISTINCT p.sub AS sub FROM school_series_students ss
           JOIN school_lesson_series s ON s.id = ss.series_id
           JOIN school_persons p ON p.id = s.teacher_id
           WHERE ss.student_id = ? AND p.sub IS NOT NULL`,
        )
        .all(sid) as { sub: string }[];
      for (const r of [...teachers, ...seriesTeachers]) peers.add(r.sub);
    }
  }
  if (roles.includes("student") && personId) {
    const teachers = db
      .prepare(
        `SELECT DISTINCT p.sub AS sub FROM school_lessons l
         JOIN school_lesson_students ls ON ls.lesson_id = l.id
         JOIN school_persons p ON p.id = l.teacher_id OR p.id = l.substitute_teacher_id
         WHERE ls.student_id = ? AND p.sub IS NOT NULL`,
      )
      .all(personId) as { sub: string }[];
    for (const r of teachers) peers.add(r.sub);
  }
  // Everyone may reach admins
  const admins = db
    .prepare(
      "SELECT sub FROM school_persons WHERE sub IS NOT NULL AND kind = 'staff' AND deleted_at IS NULL",
    )
    .all() as { sub: string }[];
  for (const r of admins) peers.add(r.sub);
  peers.delete(sub);
  return peers;
}

/* ------------------------------------------------------------------- CSV */

/** Minimal CSV parser (`,`/`;`/tab auto-detected, quoted fields, CRLF/LF, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.slice(0, src.indexOf("\n") + 1 || src.length);
  const delim = first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/* ----------------------------------------------------------------- Matrix */

/** Best-effort Matrix delivery via a school bot (D56). Returns detail or throws. */
export async function deliverMatrix(
  fetchImpl: Fetch,
  baseUrl: string,
  token: string,
  matrixId: string,
  text: string,
): Promise<string> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const room = await fetchImpl(`${base}/_matrix/client/v3/createRoom`, {
    method: "POST",
    headers,
    body: JSON.stringify({ is_direct: true, invite: [matrixId], preset: "trusted_private_chat" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!room.ok) throw new Error(`createRoom ${room.status}`);
  const { room_id } = (await room.json()) as { room_id?: string };
  if (!room_id) throw new Error("no room_id");
  const txn = `school-${uuid()}`;
  const sent = await fetchImpl(
    `${base}/_matrix/client/v3/rooms/${encodeURIComponent(room_id)}/send/m.room.message/${txn}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ msgtype: "m.text", body: text }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!sent.ok) throw new Error(`send ${sent.status}`);
  return room_id;
}
