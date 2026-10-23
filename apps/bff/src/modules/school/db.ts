import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * School module persistence (D56): module-owned SQLite file so the ~25 school
 * tables stay out of the shared db.ts schema. `path` may be ":memory:" (tests).
 * Dates are local `YYYY-MM-DD`, times `HH:MM` (single-site school, Europe/Berlin);
 * `created_at`/`updated_at` instants are UTC ISO.
 */

export type Role = "admin" | "teacher" | "parent" | "student";
export type PersonKind = "student" | "guardian" | "teacher" | "staff";
export type Attendance = "attended" | "absent_excused" | "absent_unexcused" | "cancelled";
export type LessonStatus =
  | "scheduled"
  | "cancelled_school"
  | "cancelled_teacher"
  | "cancelled_parent";

export interface SchoolUser {
  sub: string;
  name: string | null;
  email: string | null;
  lastSeen: string;
}

export interface Person {
  id: string;
  sub: string | null;
  kind: PersonKind;
  name: string;
  email: string | null;
  phone: string | null;
  birthdate: string | null;
  matrixId: string | null;
  active: number;
  notes: string | null;
  billingMode: "flat" | "per_lesson" | "per_scheduled" | "none";
  flatCents: number | null;
  lessonCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Household {
  id: string;
  name: string;
  address: string | null;
  iban: string | null;
  discountPct: number;
  notes: string | null;
}

export interface HouseholdMember {
  householdId: string;
  personId: string;
  relation: "guardian" | "student";
}

export interface LessonType {
  id: string;
  name: string;
  durationMin: number;
  defaultRateCents: number;
  active: number;
}

export interface Series {
  id: string;
  teacherId: string;
  lessonTypeId: string | null;
  weekday: number;
  startTime: string;
  durationMin: number;
  validFrom: string;
  validUntil: string | null;
  location: string | null;
  title: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lesson {
  id: string;
  seriesId: string | null;
  teacherId: string;
  substituteTeacherId: string | null;
  lessonTypeId: string | null;
  date: string;
  startTime: string;
  durationMin: number;
  location: string | null;
  status: LessonStatus;
  cancelReason: string | null;
  isMakeup: number;
  makeupForLessonId: string | null;
  overrideConflicts: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LessonStudent {
  lessonId: string;
  studentId: string;
  attendance: Attendance | null;
  privateNote: string | null;
  publicNote: string | null;
  practice: string | null;
  markedBySub: string | null;
  markedAt: string | null;
}

export interface MakeupRequest {
  id: string;
  studentId: string;
  lessonId: string;
  requestedBySub: string;
  status: "open" | "scheduled" | "declined" | "done";
  note: string | null;
  makeupLessonId: string | null;
  createdAt: string;
}

export interface Holiday {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  kind: "holiday" | "closure";
}

export interface Availability {
  id: string;
  teacherId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validUntil: string | null;
}

export interface TeacherAbsence {
  id: string;
  teacherId: string;
  startDate: string;
  endDate: string;
  kind: "vacation" | "sick" | "other";
  note: string | null;
}

export interface Instrument {
  id: string;
  name: string;
  category: string | null;
  serialNo: string | null;
  condition: string | null;
  status: "available" | "rented" | "maintenance" | "retired";
  monthlyRateCents: number;
  notes: string | null;
  createdAt: string;
}

export interface Rental {
  id: string;
  instrumentId: string;
  studentId: string;
  startDate: string;
  endDate: string | null;
  monthlyRateCents: number;
  status: "active" | "returned";
  notes: string | null;
  createdAt: string;
}

export interface Invoice {
  id: string;
  householdId: string;
  period: string;
  number: string;
  status: "draft" | "issued" | "paid" | "cancelled";
  totalCents: number;
  issuedAt: string | null;
  dueDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  kind: "flat" | "lesson" | "rental" | "discount" | "adjustment";
  label: string;
  qty: number;
  unitCents: number;
  amountCents: number;
  refId: string | null;
}

export interface Payment {
  id: string;
  invoiceId: string;
  paidAt: string;
  amountCents: number;
  method: string | null;
  note: string | null;
}

export interface Thread {
  id: string;
  kind: "direct" | "announcement";
  title: string | null;
  createdBySub: string;
  audience: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  senderSub: string;
  body: string;
  createdAt: string;
}

export interface Delivery {
  id: string;
  messageId: string;
  channel: "inapp" | "matrix" | "whatsapp";
  targetSub: string;
  status: "sent" | "pending" | "failed" | "manual";
  detail: string | null;
  at: string;
}

export interface SchoolEvent {
  id: string;
  kind: "concert" | "recital" | "exam" | "other";
  title: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  teacherId: string | null;
  createdAt: string;
}

export interface AuditRow {
  id: number;
  sub: string;
  action: string;
  entity: string;
  entityId: string | null;
  detail: string | null;
  at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS school_users (
  sub TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_persons (
  id TEXT PRIMARY KEY,
  sub TEXT UNIQUE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  birthdate TEXT,
  matrix_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  billing_mode TEXT NOT NULL DEFAULT 'none',
  flat_cents INTEGER,
  lesson_cents INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS school_persons_kind ON school_persons(kind, active);
CREATE TABLE IF NOT EXISTS school_households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  iban TEXT,
  discount_pct INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_household_members (
  household_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (household_id, person_id)
);
CREATE INDEX IF NOT EXISTS school_hm_person ON school_household_members(person_id);
CREATE TABLE IF NOT EXISTS school_lesson_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  default_rate_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS school_lesson_series (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  lesson_type_id TEXT,
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  location TEXT,
  title TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS school_series_students (
  series_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  PRIMARY KEY (series_id, student_id)
);
CREATE INDEX IF NOT EXISTS school_ss_student ON school_series_students(student_id);
CREATE TABLE IF NOT EXISTS school_lessons (
  id TEXT PRIMARY KEY,
  series_id TEXT,
  teacher_id TEXT NOT NULL,
  substitute_teacher_id TEXT,
  lesson_type_id TEXT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  cancel_reason TEXT,
  is_makeup INTEGER NOT NULL DEFAULT 0,
  makeup_for_lesson_id TEXT,
  override_conflicts INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (series_id, date)
);
CREATE INDEX IF NOT EXISTS school_lessons_date ON school_lessons(date);
CREATE INDEX IF NOT EXISTS school_lessons_teacher ON school_lessons(teacher_id, date);
CREATE TABLE IF NOT EXISTS school_lesson_students (
  lesson_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  attendance TEXT,
  private_note TEXT,
  public_note TEXT,
  practice TEXT,
  marked_by_sub TEXT,
  marked_at TEXT,
  PRIMARY KEY (lesson_id, student_id)
);
CREATE INDEX IF NOT EXISTS school_ls_student ON school_lesson_students(student_id);
CREATE TABLE IF NOT EXISTS school_makeup_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  requested_by_sub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT,
  makeup_lesson_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_holidays (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'holiday'
);
CREATE TABLE IF NOT EXISTS school_teacher_availability (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT
);
CREATE INDEX IF NOT EXISTS school_avail_teacher ON school_teacher_availability(teacher_id, weekday);
CREATE TABLE IF NOT EXISTS school_teacher_absences (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  note TEXT
);
CREATE INDEX IF NOT EXISTS school_abs_teacher ON school_teacher_absences(teacher_id);
CREATE TABLE IF NOT EXISTS school_instruments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  serial_no TEXT,
  condition TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  monthly_rate_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_rentals (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  monthly_rate_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_rentals_inst ON school_rentals(instrument_id);
CREATE INDEX IF NOT EXISTS school_rentals_student ON school_rentals(student_id);
CREATE TABLE IF NOT EXISTS school_invoices (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  period TEXT NOT NULL,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft',
  total_cents INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT,
  due_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, period)
);
CREATE TABLE IF NOT EXISTS school_invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  ref_id TEXT
);
CREATE INDEX IF NOT EXISTS school_il_invoice ON school_invoice_lines(invoice_id);
CREATE TABLE IF NOT EXISTS school_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  method TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS school_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT,
  created_by_sub TEXT NOT NULL,
  audience TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_thread_members (
  thread_id TEXT NOT NULL,
  sub TEXT NOT NULL,
  last_read_at TEXT,
  PRIMARY KEY (thread_id, sub)
);
CREATE INDEX IF NOT EXISTS school_tm_sub ON school_thread_members(sub);
CREATE TABLE IF NOT EXISTS school_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  sender_sub TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_msg_thread ON school_messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS school_deliveries (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target_sub TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'other',
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  description TEXT,
  teacher_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS school_event_participants (
  event_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  piece TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  note TEXT,
  PRIMARY KEY (event_id, student_id)
);
CREATE TABLE IF NOT EXISTS school_event_rehearsals (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60,
  location TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS school_consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  by_sub TEXT,
  at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS school_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS school_audit_entity ON school_audit(entity, entity_id);
`;

/** Opens (and initializes) the school database. `path` may be ":memory:". */
export function openSchoolDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

/** One audit row — every sensitive write goes through this. */
export function audit(
  db: DatabaseSync,
  sub: string,
  action: string,
  entity: string,
  entityId: string | null,
  detail?: unknown,
): void {
  db.prepare(
    "INSERT INTO school_audit (sub, action, entity, entity_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sub, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail), now());
}

/** Maps a snake_case row onto camelCase keys listed in `map` ({snake: camel}). */
export function mapRow<T>(row: Record<string, unknown>, map: Record<string, string>): T {
  const out: Record<string, unknown> = {};
  for (const [snake, camel] of Object.entries(map)) out[camel] = row[snake];
  return out as T;
}

export const PERSON_MAP = {
  id: "id",
  sub: "sub",
  kind: "kind",
  name: "name",
  email: "email",
  phone: "phone",
  birthdate: "birthdate",
  matrix_id: "matrixId",
  active: "active",
  notes: "notes",
  billing_mode: "billingMode",
  flat_cents: "flatCents",
  lesson_cents: "lessonCents",
  created_at: "createdAt",
  updated_at: "updatedAt",
} as const;

export const LESSON_MAP = {
  id: "id",
  series_id: "seriesId",
  teacher_id: "teacherId",
  substitute_teacher_id: "substituteTeacherId",
  lesson_type_id: "lessonTypeId",
  date: "date",
  start_time: "startTime",
  duration_min: "durationMin",
  location: "location",
  status: "status",
  cancel_reason: "cancelReason",
  is_makeup: "isMakeup",
  makeup_for_lesson_id: "makeupForLessonId",
  override_conflicts: "overrideConflicts",
  notes: "notes",
  created_at: "createdAt",
  updated_at: "updatedAt",
} as const;

export const SERIES_MAP = {
  id: "id",
  teacher_id: "teacherId",
  lesson_type_id: "lessonTypeId",
  weekday: "weekday",
  start_time: "startTime",
  duration_min: "durationMin",
  valid_from: "validFrom",
  valid_until: "validUntil",
  location: "location",
  title: "title",
  notes: "notes",
  created_at: "createdAt",
  updated_at: "updatedAt",
} as const;

export function person(db: DatabaseSync, id: string): Person | undefined {
  const row = db
    .prepare(`SELECT * FROM school_persons WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapRow<Person>(row, PERSON_MAP) : undefined;
}

export function personBySub(db: DatabaseSync, sub: string): Person | undefined {
  const row = db
    .prepare(`SELECT * FROM school_persons WHERE sub = ? AND deleted_at IS NULL`)
    .get(sub) as Record<string, unknown> | undefined;
  return row ? mapRow<Person>(row, PERSON_MAP) : undefined;
}
