import type { DatabaseSync } from "node:sqlite";
import type { FastifyReply, FastifyRequest } from "fastify";
import { now, type Person, personBySub, type Role } from "./db.js";

export interface SchoolConfig {
  DB?: string;
  GROUP_ADMIN: string;
  GROUP_TEACHER: string;
  GROUP_PARENT: string;
  GROUP_STUDENT: string;
  MATRIX_URL?: string;
  MATRIX_TOKEN?: string;
  SEED?: string;
}

/** Roles derived from the Authentik `groups` claim (D56). */
export function rolesOf(groups: string[] | undefined, cfg: SchoolConfig): Role[] {
  const g = new Set(groups ?? []);
  const roles: Role[] = [];
  if (g.has(cfg.GROUP_ADMIN)) roles.push("admin");
  if (g.has(cfg.GROUP_TEACHER)) roles.push("teacher");
  if (g.has(cfg.GROUP_PARENT)) roles.push("parent");
  if (g.has(cfg.GROUP_STUDENT)) roles.push("student");
  return roles;
}

/** Records the caller in school_users so admins can link logins to profiles. */
export function touchUser(db: DatabaseSync, user: { sub: string; name?: string; email?: string }) {
  db.prepare(
    `INSERT INTO school_users (sub, name, email, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET name = excluded.name, email = excluded.email,
       last_seen = excluded.last_seen`,
  ).run(user.sub, user.name ?? null, user.email ?? null, now());
}

/** Request context bundle resolved per call. */
export interface Caller {
  sub: string;
  roles: Role[];
  /** Linked profile, if any. */
  person: Person | null;
}

export function callerOf(db: DatabaseSync, req: FastifyRequest, cfg: SchoolConfig): Caller {
  return {
    sub: req.user.sub,
    roles: rolesOf(req.user.groups, cfg),
    person: personBySub(db, req.user.sub) ?? null,
  };
}

export function forbidden(reply: FastifyReply) {
  return reply.code(403).send({ error: "forbidden" });
}

/** Gate: caller must hold at least one of `roles`. */
export function needRole(caller: Caller, reply: FastifyReply, ...roles: Role[]): boolean {
  if (!caller.roles.some((r) => roles.includes(r))) {
    forbidden(reply);
    return false;
  }
  return true;
}

export const isAdmin = (c: Caller) => c.roles.includes("admin");
export const isStaff = (c: Caller) => c.roles.includes("admin") || c.roles.includes("teacher");

/** The caller's own student id, when they are a linked student profile. */
export const ownStudentId = (c: Caller) => (c.person?.kind === "student" ? c.person.id : null);

/** The caller's teacher person id. */
export const ownTeacherId = (c: Caller) => (c.person?.kind === "teacher" ? c.person.id : null);
