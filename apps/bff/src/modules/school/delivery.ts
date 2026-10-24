import type { DatabaseSync } from "node:sqlite";
import type { Fetch } from "../../nextcloud/client.js";
import { audit, now } from "./db.js";
import { deliverMatrix, uuid } from "./domain.js";
import type { SchoolConfig } from "./scope.js";

/**
 * Writes delivery rows for a new message; attempts Matrix fan-out when
 * configured, records a manual WhatsApp step otherwise (D56/D57).
 */
export async function deliver(
  db: DatabaseSync,
  cfg: SchoolConfig,
  fetchImpl: Fetch,
  messageId: string,
  body: string,
  senderSub: string,
  memberSubs: string[],
): Promise<void> {
  const ins = db.prepare(
    `INSERT INTO school_deliveries (id, message_id, channel, target_sub, status, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const matrixOf = db.prepare(
    "SELECT matrix_id AS m FROM school_persons WHERE sub = ? AND matrix_id IS NOT NULL",
  );
  for (const sub of memberSubs) {
    if (sub === senderSub) continue;
    ins.run(uuid(), messageId, "inapp", sub, "sent", null, now());
    const matrixId = (matrixOf.get(sub) as { m: string } | undefined)?.m;
    if (cfg.MATRIX_URL && cfg.MATRIX_TOKEN && matrixId) {
      try {
        const room = await deliverMatrix(
          fetchImpl,
          cfg.MATRIX_URL,
          cfg.MATRIX_TOKEN,
          matrixId,
          body,
        );
        ins.run(uuid(), messageId, "matrix", sub, "sent", room, now());
      } catch (e) {
        ins.run(uuid(), messageId, "matrix", sub, "failed", String(e), now());
      }
    } else if (matrixId) {
      ins.run(uuid(), messageId, "whatsapp", sub, "manual", matrixId, now());
    }
  }
}

/**
 * Posts a system-style notification from `fromSub` to `toSubs` — reuses an
 * existing direct thread with exactly that member set or creates one, then
 * inserts the message and runs delivery fan-out (D57).
 */
export async function postDirect(
  db: DatabaseSync,
  cfg: SchoolConfig,
  fetchImpl: Fetch,
  fromSub: string,
  toSubs: string[],
  title: string,
  body: string,
): Promise<void> {
  const members = [...new Set([fromSub, ...toSubs])].sort();
  if (members.length < 2) return;
  // Find a direct thread whose member set is exactly `members`.
  const candidates = db
    .prepare(
      `SELECT t.id FROM school_threads t
       WHERE t.kind = 'direct'
         AND (SELECT COUNT(*) FROM school_thread_members m WHERE m.thread_id = t.id) = ?`,
    )
    .all(members.length) as { id: string }[];
  const membersOf = db.prepare(
    "SELECT sub FROM school_thread_members WHERE thread_id = ? ORDER BY sub",
  );
  let threadId: string | null = null;
  for (const cand of candidates) {
    const subs = (membersOf.all(cand.id) as { sub: string }[]).map((r) => r.sub);
    if (subs.length === members.length && subs.every((s, i) => s === members[i])) {
      threadId = cand.id;
      break;
    }
  }
  const ts = now();
  if (!threadId) {
    threadId = uuid();
    db.prepare(
      "INSERT INTO school_threads (id, kind, title, created_by_sub, audience, created_at) VALUES (?, 'direct', ?, ?, NULL, ?)",
    ).run(threadId, title, fromSub, ts);
    const insM = db.prepare(
      "INSERT INTO school_thread_members (thread_id, sub, last_read_at) VALUES (?, ?, ?)",
    );
    for (const s of members) insM.run(threadId, s, s === fromSub ? ts : null);
  }
  const mid = uuid();
  db.prepare(
    "INSERT INTO school_messages (id, thread_id, sender_sub, body, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(mid, threadId, fromSub, body, ts);
  await deliver(db, cfg, fetchImpl, mid, body, fromSub, members);
  audit(db, fromSub, "notify", "thread", threadId, { title });
}
