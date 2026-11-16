import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { AuthenticatedNextcloud, TalkMessage } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

/** Authenticated client for the caller, or null when Nextcloud is disconnected. */
function ncFor(ctx: AppContext, sub: string): AuthenticatedNextcloud | null {
  const cred = ctx.store.getCredential(sub);
  return cred
    ? ctx.nextcloud.withCredentials(cred.loginName, ctx.secrets.open(cred.appPasswordSealed))
    : null;
}

const refId = () => randomBytes(32).toString("hex");

/** Strip a file name down to a safe single path segment. */
function safeName(raw: string): string {
  const base = raw.replaceAll("\\", "/").split("/").at(-1) ?? "image";
  const clean = base.replaceAll(/[^\w. ()+-]/g, "_").slice(0, 120) || "image";
  return clean.startsWith(".") ? `_${clean}` : clean;
}

const sendSchema = z.object({ text: z.string().min(1).max(32000) });

const configSchema = z.object({
  /**
   * Comma-separated Talk conversation tokens the module is scoped to (D67).
   * Unset/empty = all rooms. Filter semantics: surface scoping, not
   * authorization — message/image/file routes keep answering any token.
   */
  ROOMS: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(z.string().min(1)).optional(),
  ),
});

type TalkConfig = z.infer<typeof configSchema>;

/** Allowlist set when ROOMS is configured, else null (no scoping). */
function allowedRooms(config: TalkConfig): Set<string> | null {
  return config.ROOMS?.length ? new Set(config.ROOMS) : null;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/**
 * Basic Nextcloud Talk (D51): rooms, message history, text send, image
 * send via the files_sharing OCS flow (DAV upload → shareType 10). The
 * `messageParameters` rich objects pass through untouched so the app can
 * resolve `file` attachments via `/api/talk/file`.
 */
export const talkModule: BffModule<TalkConfig> = {
  id: "talk",
  version: "0.1.0",
  requires: ["nextcloud"],
  configSchema,

  notifications(ctx, config) {
    return {
      // Rooms with unread messages → einhub items; dedupe by room token.
      async poll(sub) {
        const nc = ncFor(ctx, sub);
        if (!nc) return [];
        const allowed = allowedRooms(config);
        try {
          const res = await nc.getTalkRooms();
          return (res.ocs?.data ?? [])
            .filter((r) => (r.unreadMessages ?? 0) > 0 && (!allowed || allowed.has(r.token)))
            .map((r) => ({
              sourceId: `talk:${r.token}`,
              title: r.displayName || r.name || "Talk",
              body: r.lastMessage?.message?.slice(0, 200),
              at: r.lastActivity ? new Date(r.lastActivity * 1000).toISOString() : undefined,
            }));
        } catch {
          return [];
        }
      },
    };
  },

  register(api, ctx, config) {
    api.get("/rooms", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const allowed = allowedRooms(config);
      const res = await nc.getTalkRooms();
      const data = res.ocs?.data ?? [];
      const joined = allowed ? data.filter((r) => allowed.has(r.token)) : data;
      const rooms: {
        token: string;
        name: string;
        displayName: string;
        type: number;
        unread: number;
        lastActivity: number;
        lastMessage: string | null;
        member?: boolean;
      }[] = joined.map((r) => ({
        token: r.token,
        name: r.name ?? "",
        displayName: r.displayName || r.name || "",
        type: r.type ?? 0,
        unread: r.unreadMessages ?? 0,
        lastActivity: r.lastActivity ?? 0,
        lastMessage: r.lastMessage?.message ?? null,
      }));
      if (allowed) {
        // Configured rooms the user hasn't joined surface as member:false
        // stubs so the app can show "not a member" instead of hiding them (D67).
        const seen = new Set(rooms.map((r) => r.token));
        for (const token of config.ROOMS ?? []) {
          if (!seen.has(token)) {
            rooms.push({
              token,
              name: "",
              displayName: "",
              type: 0,
              unread: 0,
              lastActivity: 0,
              lastMessage: null,
              member: false,
            });
          }
        }
      }
      return { rooms };
    });

    api.get("/rooms/:token/messages", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const token = (req.params as { token: string }).token;
      const q = req.query as { lastKnown?: string; limit?: string };
      const lastKnown = q.lastKnown ? Number(q.lastKnown) : undefined;
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
      const res = await nc.getTalkMessages(
        token,
        Number.isInteger(lastKnown) ? lastKnown : undefined,
        limit,
      );
      return { messages: (res.ocs?.data ?? []) as TalkMessage[] };
    });

    api.post("/rooms/:token/messages", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {text}" });
      const token = (req.params as { token: string }).token;
      const res = await nc.postTalkMessage(token, parsed.data.text, refId());
      return reply.code(201).send({ message: res.ocs?.data ?? null });
    });

    // Raw-body image upload → Talk folder → OCS share (D51).
    api.addContentTypeParser(
      [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/heic",
        "application/octet-stream",
      ],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    api.post("/rooms/:token/image", { bodyLimit: 20 * 1024 * 1024 }, async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const token = (req.params as { token: string }).token;
      const q = req.query as { name?: string; caption?: string };
      if (!q.name) return reply.code(400).send({ error: "expected ?name=<file>" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected the image bytes as the request body" });
      }
      const ext = safeName(q.name).split(".").at(-1)?.toLowerCase() ?? "png";
      const contentType = MIME[ext] ?? "application/octet-stream";
      const path = `Talk/${Date.now()}-${safeName(q.name)}`;

      await nc.davMkcol("Talk");
      await nc.davPutFile(path, body, contentType);
      const share = await nc.shareFileToTalk(token, `/${path}`, refId(), q.caption);
      return reply.code(201).send({ path, share: share?.ocs?.data ?? null });
    });

    // Authenticated byte proxy for shared-file display (D51).
    api.get("/file", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const path = (req.query as { path?: string }).path ?? "";
      if (!path || path.includes("..")) {
        return reply.code(400).send({ error: "invalid path" });
      }
      const data = await nc.davGetBytes(path);
      const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
      return reply
        .header("Content-Type", MIME[ext] ?? "application/octet-stream")
        .header("Cache-Control", "private, max-age=300")
        .send(data);
    });
  },
};
