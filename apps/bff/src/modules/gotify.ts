import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  type ConnectorOptions,
  connectorCred,
  connectorGet,
  normalizeBase,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default instance URL for the deployment; the connect form may override it. */
  URL: z.url().optional(),
});
type GotifyConfig = z.infer<typeof configSchema>;

/** Stored secret: the client token minted at connect time — never the password. */
interface GotifySecret {
  token: string;
  clientId: number;
}

export function parseGotifySecret(secret: string): GotifySecret | null {
  try {
    const s = JSON.parse(secret) as GotifySecret;
    return typeof s.token === "string" && typeof s.clientId === "number" ? s : null;
  } catch {
    return null;
  }
}

/** Gotify client-token auth header. */
function authHeaders(secret: GotifySecret): Record<string, string> {
  return { "X-Gotify-Key": secret.token };
}

export interface GotifyMessage {
  id: number;
  appId: number;
  title: string | null;
  message: string;
  date: string;
  priority: number;
  /** extras["client::display"].contentType — e.g. "text/markdown". */
  contentType: string | null;
}

interface GotifyMessageRaw {
  id: number;
  appid: number;
  title?: string;
  message: string;
  date: string;
  priority: number;
  extras?: Record<string, Record<string, unknown>>;
}

export interface GotifyApplication {
  id: number;
  name: string;
  description: string | null;
  token: string;
}

function mapMessage(m: GotifyMessageRaw): GotifyMessage {
  const contentType = m.extras?.["client::display"]?.contentType;
  return {
    id: m.id,
    appId: m.appid,
    title: m.title ?? null,
    message: m.message,
    date: m.date,
    priority: m.priority ?? 0,
    contentType: typeof contentType === "string" ? contentType : null,
  };
}

function mapApplication(a: {
  id: number;
  name: string;
  description?: string;
  token: string;
}): GotifyApplication {
  return { id: a.id, name: a.name, description: a.description ?? null, token: a.token };
}

/** The credential for the caller, with parsed token — null when not connected. */
function credFor(ctx: AppContext, sub: string) {
  const c = connectorCred(ctx, sub, "gotify");
  const secret = c ? parseGotifySecret(c.secret) : null;
  return c && secret ? { url: c.url, secret } : null;
}

async function gotifyGet<T>(
  ctx: AppContext,
  url: string,
  secret: GotifySecret,
  path: string,
): Promise<{ status: number; body: T | null }> {
  return connectorGet<T>(ctx.fetchImpl ?? fetch, url, path, authHeaders(secret));
}

/** Minimal WS client shape — Node ≥22.4 ships a global WebSocket. */
interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  close(): void;
}

export function gotifyWsUrl(baseUrl: string, token: string): string {
  return `${normalizeBase(baseUrl).replace(/^http/i, "ws")}/stream?token=${encodeURIComponent(token)}`;
}

const options = (config: GotifyConfig): ConnectorOptions => ({
  service: "gotify",
  defaultUrl: config.URL,
  parseSecret: userPassSecret,
  // Android-app login: create a client token via Basic auth, store only the token.
  verify: async (fetchImpl, url, secretJson) => {
    const { username, password } = JSON.parse(secretJson) as {
      username: string;
      password: string;
    };
    const res = await fetchImpl(`${normalizeBase(url)}/client`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ name: "einring" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return res.status;
    const client = (await res.json()) as { id: number; token: string };
    if (typeof client.id !== "number" || typeof client.token !== "string") return 502;
    return {
      status: res.status,
      secret: JSON.stringify({ token: client.token, clientId: client.id }),
    };
  },
  // Logout mirrors the app: delete the client so the token dies upstream.
  onDisconnect: async (fetchImpl, url, secretJson) => {
    const secret = parseGotifySecret(secretJson);
    if (!secret) return;
    await fetchImpl(`${normalizeBase(url)}/client/${secret.clientId}`, {
      method: "DELETE",
      headers: authHeaders(secret),
      signal: AbortSignal.timeout(15_000),
    });
  },
});

export const gotifyModule: BffModule<GotifyConfig> = {
  id: "gotify",
  configSchema,

  notifications(ctx) {
    return {
      // New pushed messages → einhub items; dedupe by upstream message id.
      async poll(sub) {
        const cred = credFor(ctx, sub);
        if (!cred) return [];
        const res = await gotifyGet<{ messages?: GotifyMessageRaw[] }>(
          ctx,
          cred.url,
          cred.secret,
          "/message?limit=10",
        );
        if (!res.body) return [];
        return (res.body.messages ?? []).map((m) => ({
          sourceId: String(m.id),
          title: m.title ?? "Gotify",
          body: m.message.slice(0, 500),
          at: m.date,
        }));
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "gotify_recent_messages",
        description:
          "List the user's recent Gotify push notifications (title, content, sending app, priority, time).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max messages to return (default 10, max 50)" },
          },
        },
        async call(args, sub) {
          const cred = credFor(ctx, sub);
          if (!cred) return { error: "not_connected" };
          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
          const res = await gotifyGet<{ messages?: GotifyMessageRaw[] }>(
            ctx,
            cred.url,
            cred.secret,
            `/message?limit=${limit}`,
          );
          if (!res.body) return { error: `gotify returned ${res.status}` };
          return { messages: (res.body.messages ?? []).map(mapMessage) };
        },
      },
      {
        name: "gotify_applications",
        description:
          "List the user's Gotify applications (the senders — scripts/services that post notifications).",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const cred = credFor(ctx, sub);
          if (!cred) return { error: "not_connected" };
          const res = await gotifyGet<
            { id: number; name: string; description?: string; token: string }[]
          >(ctx, cred.url, cred.secret, "/application");
          if (!res.body) return { error: `gotify returned ${res.status}` };
          return { applications: res.body.map(mapApplication) };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, options(config));
    const fetchImpl = ctx.fetchImpl ?? fetch;

    const cred = (sub: string) => credFor(ctx, sub);
    const upstream = async (
      sub: string,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<{ status: number; json: unknown } | null> => {
      const c = cred(sub);
      if (!c) return null;
      const res = await fetchImpl(`${normalizeBase(c.url)}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...authHeaders(c.secret),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const jsonBody = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, json: jsonBody };
    };

    api.get("/messages", async (req, reply) => {
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string }).limit) || 50, 1),
        200,
      );
      const since = Number((req.query as { since?: string }).since);
      const q = Number.isFinite(since) && since > 0 ? `&since=${since}` : "";
      const c = cred(req.user.sub);
      if (!c) return reply.code(424).send({ error: "not connected" });
      const res = await gotifyGet<{ messages?: GotifyMessageRaw[] }>(
        ctx,
        c.url,
        c.secret,
        `/message?limit=${limit}${q}`,
      );
      if (res.status === 401 || res.status === 403)
        return reply.code(401).send({ error: "gotify rejected the client token" });
      if (!res.body) return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { messages: (res.body.messages ?? []).map(mapMessage) };
    });

    api.get("/user", async (req, reply) => {
      const c = cred(req.user.sub);
      if (!c) return reply.code(424).send({ error: "not connected" });
      const res = await gotifyGet<{ id: number; name: string; admin: boolean }>(
        ctx,
        c.url,
        c.secret,
        "/current/user",
      );
      if (res.status === 401 || res.status === 403)
        return reply.code(401).send({ error: "gotify rejected the client token" });
      if (!res.body) return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { name: res.body.name, admin: res.body.admin === true };
    });

    api.get("/applications", async (req, reply) => {
      const c = cred(req.user.sub);
      if (!c) return reply.code(424).send({ error: "not connected" });
      const res = await gotifyGet<
        { id: number; name: string; description?: string; token: string }[]
      >(ctx, c.url, c.secret, "/application");
      if (res.status === 401 || res.status === 403)
        return reply.code(401).send({ error: "gotify rejected the client token" });
      if (!res.body) return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { applications: res.body.map(mapApplication) };
    });

    api.post("/applications", async (req, reply) => {
      const parsed = z
        .object({ name: z.string().min(1).max(200), description: z.string().max(500).optional() })
        .safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {name, description?}" });
      const res = await upstream(req.user.sub, "POST", "/application", parsed.data);
      if (!res) return reply.code(424).send({ error: "not connected" });
      if (!res.json) return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      const app = res.json as { id: number; name: string; description?: string; token: string };
      return { application: mapApplication(app) };
    });

    api.delete("/applications/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "invalid id" });
      const res = await upstream(req.user.sub, "DELETE", `/application/${id}`);
      if (!res) return reply.code(424).send({ error: "not connected" });
      if (res.status === 404) return reply.code(404).send({ error: "unknown application" });
      if (res.status >= 400)
        return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { deleted: true };
    });

    api.delete("/messages/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "invalid id" });
      const res = await upstream(req.user.sub, "DELETE", `/message/${id}`);
      if (!res) return reply.code(424).send({ error: "not connected" });
      if (res.status === 404) return reply.code(404).send({ error: "unknown message" });
      if (res.status >= 400)
        return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { deleted: true };
    });

    api.delete("/messages", async (req, reply) => {
      const res = await upstream(req.user.sub, "DELETE", "/message");
      if (!res) return reply.code(424).send({ error: "not connected" });
      if (res.status >= 400)
        return reply.code(502).send({ error: `gotify unreachable (${res.status})` });
      return { deleted: true };
    });

    /**
     * Live updates: upstream /stream is a WebSocket — the browser can't reach it
     * (the client token never leaves the BFF), so we proxy it as SSE. The app
     * only needs "something arrived" to invalidate its list.
     */
    api.get("/stream", (req, reply) => {
      const c = cred(req.user.sub);
      if (!c) return reply.code(424).send({ error: "not connected" });
      const WS = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
      if (!WS) return reply.code(501).send({ error: "websocket client unavailable" });
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      reply.raw.write(": connected\n\n");
      const ws = new WS(gotifyWsUrl(c.url, c.secret.token));
      const heartbeat = setInterval(() => reply.raw.write(": hb\n\n"), 25_000);
      ws.onopen = () => api.log.info({ url: c.url }, "gotify stream: upstream ws open");
      ws.onmessage = (ev) => {
        api.log.info({ url: c.url }, "gotify stream: message received");
        reply.raw.write(`data: ${String(ev.data)}\n\n`);
      };
      const end = (reason: string) => {
        api.log.info({ url: c.url }, `gotify stream ended: ${reason}`);
        clearInterval(heartbeat);
        reply.raw.end();
      };
      ws.onclose = () => end("upstream close");
      ws.onerror = (ev) => {
        api.log.warn({ url: c.url, err: String(ev) }, "gotify stream: upstream ws error");
        end("upstream error");
      };
      req.raw.on("close", () => {
        api.log.info({ url: c.url }, "gotify stream: client disconnected");
        clearInterval(heartbeat);
        ws.close();
      });
    });
  },
};
