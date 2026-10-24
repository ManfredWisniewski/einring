import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openSchoolDb } from "./school/db.js";
import { materializeLessons, todayBerlin } from "./school/domain.js";
import { registerBillingRoutes } from "./school/routes-billing.js";
import { registerCoreRoutes } from "./school/routes-core.js";
import { registerHomeworkRoutes } from "./school/routes-homework.js";
import { registerScheduleRoutes } from "./school/routes-schedule.js";
import { registerSocialRoutes } from "./school/routes-social.js";
import { touchUser } from "./school/scope.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** School DB path; default <DATA_DIR>/school.sqlite. ":memory:" for tests. */
  DB: z.string().optional(),
  /** Authentik group names mapped to roles (D56). */
  GROUP_ADMIN: z.string().min(1).default("einring-school-admin"),
  GROUP_TEACHER: z.string().min(1).default("einring-school-teacher"),
  GROUP_PARENT: z.string().min(1).default("einring-school-parent"),
  GROUP_STUDENT: z.string().min(1).default("einring-school-student"),
  /** Optional Matrix delivery bot. */
  MATRIX_URL: z.string().optional(),
  MATRIX_TOKEN: z.string().optional(),
  /** Enables POST /api/school/seed (demo data, empty DB only). */
  SEED: z.string().optional(),
  /** Homework submission media directory; default <DATA_DIR>/school-media. */
  MEDIA_DIR: z.string().optional(),
});

/**
 * School module (D56): music-school management — people, recurring lessons,
 * attendance, billing, instruments, messaging, events. Roles come from the
 * Authentik `groups` claim; everything else lives in its own SQLite file.
 */
export const schoolModule: BffModule<z.infer<typeof configSchema>> = {
  id: "school",
  configSchema,

  chatTools(ctx, config): ChatTool[] {
    const db = getDb(ctx, config);
    return [
      {
        name: "school_today",
        description:
          "List today's music-school lessons visible to the caller (time, teacher, students, status).",
        parameters: { type: "object", properties: {} },
        async call(_args, _sub) {
          const today = todayBerlin();
          materializeLessons(db, today, today);
          return {
            lessons: db
              .prepare(
                `SELECT l.start_time AS startTime, l.duration_min AS durationMin, l.status,
                        p.name AS teacher, lt.name AS type
                 FROM school_lessons l
                 JOIN school_persons p ON p.id = l.teacher_id
                 LEFT JOIN school_lesson_types lt ON lt.id = l.lesson_type_id
                 WHERE l.date = ? ORDER BY l.start_time`,
              )
              .all(today),
          };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const db = getDb(ctx, config);
    // Record every caller so admins can link logins to profiles (D56).
    api.addHook("preHandler", async (req) => {
      if (req.user) touchUser(db, req.user);
    });
    // Lazy materialization: keep at least an 8-week horizon of lessons.
    materializeLessons(db, todayBerlin(), horizon(8));
    const timer = setInterval(
      () => {
        try {
          materializeLessons(db, todayBerlin(), horizon(8));
        } catch (e) {
          api.log.warn(e, "school materialization failed");
        }
      },
      24 * 3600 * 1000,
    );
    timer.unref();
    api.addHook("onClose", async () => clearInterval(timer));

    const mediaDir =
      config.MEDIA_DIR ??
      join((ctx as { config: { DATA_DIR: string } }).config.DATA_DIR, "school-media");

    registerCoreRoutes(api, db, config);
    registerScheduleRoutes(api, db, config);
    registerBillingRoutes(api, db, config);
    registerSocialRoutes(api, db, config, ctx);
    registerHomeworkRoutes(api, db, config, ctx, mediaDir);
  },
};

function horizon(weeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}

// One db per module registration — resolved lazily so chatTools and register share it.
const dbs = new WeakMap<object, DatabaseSync>();
function getDb(ctx: object, config: z.infer<typeof configSchema>): DatabaseSync {
  let db = dbs.get(ctx);
  if (!db) {
    const path =
      config.DB ?? join((ctx as { config: { DATA_DIR: string } }).config.DATA_DIR, "school.sqlite");
    db = openSchoolDb(path);
    dbs.set(ctx, db);
  }
  return db;
}
