import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Fetch } from "../nextcloud/client.js";
import {
  connectorCred,
  normalizeBase,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

/** What gets sealed: the login-exchange result — never the password (D52). */
interface MatrixSecret {
  accessToken: string;
  userId?: string;
  deviceId?: string;
}

function parseSecret(secret: string): MatrixSecret | null {
  try {
    const s = JSON.parse(secret) as Partial<MatrixSecret>;
    return typeof s.accessToken === "string" && s.accessToken ? (s as MatrixSecret) : null;
  } catch {
    return null;
  }
}

const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

async function mfetch<T>(
  fetchImpl: Fetch,
  base: string,
  path: string,
  tok: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(`${normalizeBase(base)}${path}`, {
    ...init,
    headers: { Accept: "application/json", ...auth(tok), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

const txn = () => `einring-${randomBytes(8).toString("hex")}`;

const configSchema = z.object({
  /** Optional default homeserver URL for the connect form. */
  URL: z.string().optional(),
});

const sendSchema = z.object({ text: z.string().min(1).max(32000) });

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

interface MatrixEvent {
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  type?: string;
  content?: {
    msgtype?: string;
    body?: string;
    url?: string;
    info?: { mimetype?: string; size?: number };
  };
}

/** Strip "@user:server" → "user" for display (full profile lookups stay out of scope). */
const senderName = (sender?: string) =>
  sender?.startsWith("@") ? (sender.slice(1).split(":")[0] ?? sender) : sender;

/**
 * Matrix connector (D52): basic chat + file upload via the Client-Server API.
 * The sealed secret is the access token from `m.login.password` — the password
 * itself is never persisted.
 */
export const matrixModule: BffModule<z.infer<typeof configSchema>> = {
  id: "matrix",
  configSchema,

  notifications(ctx) {
    return {
      // Unread count from an empty-timeline /sync poll → one aggregated item.
      async poll(sub) {
        const cred = connectorCred(ctx, sub, "matrix");
        const secret = cred ? parseSecret(cred.secret) : null;
        if (!cred || !secret) return [];
        const filter = encodeURIComponent(
          JSON.stringify({
            room: {
              timeline: { limit: 0 },
              state: { limit: 0 },
              ephemeral: { limit: 0 },
              account_data: { limit: 0 },
            },
            presence: { limit: 0 },
          }),
        );
        const fetchImpl = ctx.fetchImpl ?? fetch;
        const res = await mfetch<{
          rooms?: {
            join?: Record<string, { unread_notifications?: { notification_count?: number } }>;
          };
        }>(
          fetchImpl,
          cred.url,
          `/_matrix/client/v3/sync?timeout=0&filter=${filter}`,
          secret.accessToken,
        );
        if (!res.body?.rooms?.join) return [];
        let unread = 0;
        let rooms = 0;
        for (const r of Object.values(res.body.rooms.join)) {
          const n = r.unread_notifications?.notification_count ?? 0;
          if (n > 0) {
            unread += n;
            rooms += 1;
          }
        }
        return unread > 0
          ? [
              {
                sourceId: "matrix:unread",
                title: "Matrix",
                body: `${unread} unread message(s) in ${rooms} room(s)`,
              },
            ]
          : [];
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "matrix_rooms",
        description: "List the user's joined Matrix rooms (names only — no message content).",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const cred = connectorCred(ctx, sub, "matrix");
          const secret = cred ? parseSecret(cred.secret) : null;
          if (!cred || !secret) return { error: "matrix is not connected" };
          const fetchImpl = ctx.fetchImpl ?? fetch;
          const rooms = await mfetch<{ joined_rooms?: string[] }>(
            fetchImpl,
            cred.url,
            "/_matrix/client/v3/joined_rooms",
            secret.accessToken,
          );
          const names = await Promise.all(
            (rooms.body?.joined_rooms ?? []).map(async (id) => {
              const r = await mfetch<{ name?: string }>(
                fetchImpl,
                cred.url,
                `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`,
                secret.accessToken,
              );
              return { id, name: r.body?.name ?? null };
            }),
          );
          return { rooms: names };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, {
      service: "matrix",
      defaultUrl: config.URL,
      parseSecret: userPassSecret,
      async verify(fetchImpl, url, secret) {
        let creds: { username?: string; password?: string };
        try {
          creds = JSON.parse(secret);
        } catch {
          return 400;
        }
        if (!creds.username || !creds.password) return 400;
        const res = await fetchImpl(`${url}/_matrix/client/v3/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            type: "m.login.password",
            user: creds.username,
            password: creds.password,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return res.status;
        const data = (await res.json()) as {
          access_token?: string;
          user_id?: string;
          device_id?: string;
        };
        if (!data.access_token) return 502;
        // The access token replaces the user+password secret (D52).
        return {
          status: 200,
          secret: JSON.stringify({
            accessToken: data.access_token,
            userId: data.user_id,
            deviceId: data.device_id,
          }),
        };
      },
      async onDisconnect(fetchImpl, url, secret) {
        const s = parseSecret(secret);
        if (s) {
          await fetchImpl(`${normalizeBase(url)}/_matrix/client/v3/logout`, {
            method: "POST",
            headers: auth(s.accessToken),
          }).catch(() => {});
        }
      },
    });

    const credFor = (sub: string) => {
      const c = connectorCred(ctx, sub, "matrix");
      const s = c ? parseSecret(c.secret) : null;
      return c && s ? { url: c.url, tok: s.accessToken } : null;
    };
    const fetchImpl = ctx.fetchImpl ?? fetch;

    // The user's own Matrix ID — for own-message styling (sealed server-side).
    api.get("/me", async (req, reply) => {
      const c = connectorCred(ctx, req.user.sub, "matrix");
      const s = c ? parseSecret(c.secret) : null;
      if (!c || !s) return reply.code(424).send({ error: "matrix is not connected" });
      return { userId: s.userId ?? null };
    });

    api.get("/rooms", async (req, reply) => {
      const cred = credFor(req.user.sub);
      if (!cred) return reply.code(424).send({ error: "matrix is not connected" });
      const joined = await mfetch<{ joined_rooms?: string[] }>(
        fetchImpl,
        cred.url,
        "/_matrix/client/v3/joined_rooms",
        cred.tok,
      );
      if (!joined.body) {
        return reply.code(joined.status === 401 || joined.status === 403 ? 401 : 502).send({
          error: "matrix",
        });
      }
      const rooms = await Promise.all(
        (joined.body.joined_rooms ?? []).map(async (id) => {
          const r = await mfetch<{ name?: string }>(
            fetchImpl,
            cred.url,
            `/_matrix/client/v3/rooms/${encodeURIComponent(id)}/state/m.room.name`,
            cred.tok,
          );
          return { id, name: r.body?.name ?? null };
        }),
      );
      return { rooms };
    });

    api.get("/rooms/:roomId/messages", async (req, reply) => {
      const cred = credFor(req.user.sub);
      if (!cred) return reply.code(424).send({ error: "matrix is not connected" });
      const roomId = (req.params as { roomId: string }).roomId;
      const q = req.query as { from?: string; limit?: string };
      const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
      const qs = new URLSearchParams({ dir: "b", limit: String(limit) });
      if (q.from) qs.set("from", q.from);
      const res = await mfetch<{ chunk?: MatrixEvent[]; end?: string }>(
        fetchImpl,
        cred.url,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${qs}`,
        cred.tok,
      );
      if (!res.body) {
        return reply
          .code(res.status === 401 || res.status === 403 ? 401 : 502)
          .send({ error: "matrix" });
      }
      return {
        end: res.body.end ?? null,
        messages: (res.body.chunk ?? []).map((e) => ({
          id: e.event_id,
          sender: e.sender ?? "",
          senderName: senderName(e.sender),
          ts: e.origin_server_ts ?? 0,
          type: e.type ?? "",
          msgtype: e.content?.msgtype ?? null,
          body: e.content?.body ?? "",
          url: e.content?.url ?? null,
          info: e.content?.info ?? null,
        })),
      };
    });

    api.post("/rooms/:roomId/messages", async (req, reply) => {
      const cred = credFor(req.user.sub);
      if (!cred) return reply.code(424).send({ error: "matrix is not connected" });
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {text}" });
      const roomId = (req.params as { roomId: string }).roomId;
      const res = await mfetch<{ event_id?: string }>(
        fetchImpl,
        cred.url,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn()}`,
        cred.tok,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype: "m.text", body: parsed.data.text }),
        },
      );
      if (!res.body) {
        return reply
          .code(res.status === 401 || res.status === 403 ? 401 : 502)
          .send({ error: "matrix" });
      }
      return reply.code(201).send({ eventId: res.body.event_id ?? null });
    });

    // Raw-body file upload → media/v3/upload → m.image/m.file message (D52).
    api.addContentTypeParser(
      [
        "application/octet-stream",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
      ],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    api.post("/rooms/:roomId/file", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
      const cred = credFor(req.user.sub);
      if (!cred) return reply.code(424).send({ error: "matrix is not connected" });
      const roomId = (req.params as { roomId: string }).roomId;
      const q = req.query as { name?: string };
      const name = q.name?.split("/").at(-1)?.slice(0, 200);
      if (!name) return reply.code(400).send({ error: "expected ?name=<file>" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected the file bytes as the request body" });
      }
      const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
      const mimetype = MIME[ext] ?? "application/octet-stream";

      const up = await fetchImpl(
        `${normalizeBase(cred.url)}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: { ...auth(cred.tok), "Content-Type": mimetype },
          body,
          signal: AbortSignal.timeout(60_000),
        },
      );
      if (!up.ok) {
        return reply
          .code(up.status === 401 || up.status === 403 ? 401 : 502)
          .send({ error: "matrix upload failed" });
      }
      const { content_uri } = (await up.json()) as { content_uri?: string };
      if (!content_uri) return reply.code(502).send({ error: "matrix upload returned no mxc uri" });

      const msgtype = mimetype.startsWith("image/") ? "m.image" : "m.file";
      const res = await mfetch<{ event_id?: string }>(
        fetchImpl,
        cred.url,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txn()}`,
        cred.tok,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            msgtype,
            body: name,
            url: content_uri,
            info: { mimetype, size: body.length },
          }),
        },
      );
      if (!res.body) {
        return reply
          .code(res.status === 401 || res.status === 403 ? 401 : 502)
          .send({ error: "matrix" });
      }
      return reply.code(201).send({ eventId: res.body.event_id ?? null, mxc: content_uri });
    });

    // Authenticated media proxy — mxc://server/id → media/v3/download (D52).
    api.get("/media", async (req, reply) => {
      const cred = credFor(req.user.sub);
      if (!cred) return reply.code(424).send({ error: "matrix is not connected" });
      const mxc = (req.query as { mxc?: string }).mxc ?? "";
      const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxc);
      if (!m) return reply.code(400).send({ error: "expected mxc:// URI" });
      const res = await fetchImpl(
        `${normalizeBase(cred.url)}/_matrix/media/v3/download/${encodeURIComponent(m[1] ?? "")}/${encodeURIComponent(m[2] ?? "")}`,
        { headers: auth(cred.tok), signal: AbortSignal.timeout(30_000) },
      );
      if (!res.ok) {
        return reply
          .code(res.status === 401 || res.status === 403 ? 401 : 502)
          .send({ error: "matrix media" });
      }
      const type = res.headers.get("content-type") ?? "application/octet-stream";
      return reply
        .header("Content-Type", type)
        .header("Cache-Control", "private, max-age=300")
        .send(Buffer.from(await res.arrayBuffer()));
    });
  },
};
