import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  type ConnectorOptions,
  connectorCred,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default IMAP server (imaps://host:993 or bare host[:port]); the connect form may override it. */
  URL: z.string().optional(),
});
type EmailConfig = z.infer<typeof configSchema>;

/** Minimal IMAP surface the module needs — injectable for tests via ctx.imapOpen. */
export interface ImapEnvelope {
  uid: number;
  envelope?: {
    subject?: string;
    date?: Date | string;
    from?: { name?: string; address?: string }[];
  };
}
export interface ImapLike {
  mailbox: { exists: number } | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(range: string, query: { envelope: boolean; uid: boolean }): AsyncIterable<ImapEnvelope>;
  fetchOne(
    seq: number | string,
    query: { source: boolean },
    opts: { uid: boolean },
  ): Promise<{ uid: number; source?: Buffer } | false>;
  /** \\Deleted flag + expunge — imapflow's messageDelete. */
  messageDelete(range: number | string, opts: { uid: boolean }): Promise<boolean>;
}
export type ImapOpen = (cred: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}) => Promise<ImapLike>;

const LIST_LIMIT = 5;

/** Accepts imaps://host:port, imap://host:port, or bare host[:port] → canonical URI. */
export function parseImapUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const withScheme = /^imaps?:\/\//i.test(s) ? s : `imaps://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "imap:" && u.protocol !== "imaps:") return null;
  if (!u.hostname) return null;
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`;
}

function imapTarget(url: string): { host: string; port: number; secure: boolean } {
  const u = new URL(url);
  const secure = u.protocol === "imaps:";
  return { host: u.hostname, port: u.port ? Number(u.port) : secure ? 993 : 143, secure };
}

const defaultImapOpen: ImapOpen = async ({ host, port, secure, user, pass }) => {
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass },
    logger: false,
    socketTimeout: 15_000,
  });
  await client.connect();
  return client as unknown as ImapLike;
};

interface ImapSecret {
  username: string;
  password: string;
}

function credFor(ctx: AppContext, sub: string): { url: string; secret: ImapSecret } | null {
  const c = connectorCred(ctx, sub, "email");
  if (!c) return null;
  try {
    const s = JSON.parse(c.secret) as ImapSecret;
    return s.username && s.password ? { url: c.url, secret: s } : null;
  } catch {
    return null;
  }
}

function slimFrom(from?: { name?: string; address?: string }[]) {
  const f = from?.[0];
  return { name: f?.name ?? null, address: f?.address ?? null };
}

async function withImap<T>(
  ctx: AppContext,
  sub: string,
  fn: (client: ImapLike) => Promise<T>,
): Promise<T | { notConnected: true } | { failed: string }> {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true };
  const open = ctx.imapOpen ?? defaultImapOpen;
  const t = imapTarget(cred.url);
  let client: ImapLike;
  try {
    client = await open({ ...t, user: cred.secret.username, pass: cred.secret.password });
  } catch (err) {
    return { failed: err instanceof Error ? err.message : "imap connect failed" };
  }
  const lock = await client.getMailboxLock("INBOX");
  try {
    return await fn(client);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

async function listRecent(
  ctx: AppContext,
  sub: string,
): Promise<
  | { uid: number; subject: string | null; from: unknown; date: string | null }[]
  | { notConnected: true }
  | { failed: string }
> {
  const out = await withImap(ctx, sub, async (client) => {
    const total = client.mailbox === false ? 0 : client.mailbox.exists;
    if (!total) return [];
    const range = `${Math.max(1, total - LIST_LIMIT + 1)}:*`;
    const msgs: { uid: number; subject: string | null; from: unknown; date: string | null }[] = [];
    for await (const m of client.fetch(range, { envelope: true, uid: true })) {
      msgs.push({
        uid: m.uid,
        subject: m.envelope?.subject ?? null,
        from: slimFrom(m.envelope?.from),
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
      });
    }
    return msgs.reverse();
  });
  return out;
}

async function readMessage(
  ctx: AppContext,
  sub: string,
  uid: number,
): Promise<
  | {
      subject: string | null;
      from: unknown;
      date: string | null;
      text: string | null;
      html: string | null;
    }
  | { notConnected: true }
  | { notFound: true }
  | { failed: string }
> {
  return withImap(ctx, sub, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (msg === false || !msg.source) return { notFound: true };
    const parsed = await new PostalMime().parse(msg.source);
    const f = parsed.from;
    return {
      subject: parsed.subject ?? null,
      from: f ? { name: f.name ?? null, address: f.address ?? null } : null,
      date: parsed.date ? new Date(parsed.date).toISOString() : null,
      text: parsed.text ?? null,
      html: parsed.html ?? null,
    };
  });
}

async function deleteMessage(
  ctx: AppContext,
  sub: string,
  uid: number,
): Promise<{ ok: true } | { notConnected: true } | { notFound: true } | { failed: string }> {
  return withImap(ctx, sub, async (client) => {
    const exists = await client.fetchOne(String(uid), { source: false }, { uid: true });
    if (exists === false) return { notFound: true };
    await client.messageDelete(String(uid), { uid: true });
    return { ok: true };
  });
}

export const emailModule: BffModule<EmailConfig> = {
  id: "email",
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "email_recent",
        description:
          "List the user's 5 most recent inbox emails (subject, sender, date). Use for 'any new mail?' questions.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const res = await listRecent(ctx, sub);
          if (!Array.isArray(res)) {
            return "notConnected" in res
              ? { error: "not_connected" }
              : { error: `imap failed: ${res.failed}` };
          }
          return { emails: res };
        },
      },
      {
        name: "email_read",
        description: "Read one email's full text content. Needs the uid from email_recent.",
        parameters: {
          type: "object",
          properties: { uid: { type: "number", description: "Message uid from email_recent" } },
          required: ["uid"],
        },
        async call(args, sub) {
          const uid = typeof args.uid === "number" ? args.uid : Number(args.uid);
          if (!Number.isInteger(uid) || uid <= 0)
            return { error: "uid must be a positive integer" };
          const res = await readMessage(ctx, sub, uid);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("notFound" in res) return { error: "not found" };
          if ("failed" in res) return { error: `imap failed: ${res.failed}` };
          // The LLM doesn't need raw HTML when text exists.
          return { ...res, html: res.text ? null : res.html };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "email",
      defaultUrl: config.URL ? (parseImapUrl(config.URL) ?? undefined) : undefined,
      parseSecret: userPassSecret,
      parseUrl: parseImapUrl,
      verify: async (_fetchImpl, url, secretJson) => {
        let secret: ImapSecret;
        try {
          secret = JSON.parse(secretJson) as ImapSecret;
        } catch {
          return 400;
        }
        const open = ctx.imapOpen ?? defaultImapOpen;
        const t = imapTarget(url);
        try {
          const client = await open({ ...t, user: secret.username, pass: secret.password });
          await client.logout().catch(() => {});
          return 200;
        } catch (err) {
          const e = err as { authenticationFailed?: boolean; responseStatus?: string };
          return e?.authenticationFailed === true || e?.responseStatus === "NO" ? 401 : 502;
        }
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/list", async (req, reply) => {
      const res = await listRecent(ctx, req.user.sub);
      if (Array.isArray(res)) return { emails: res };
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      return reply.code(502).send({ error: `imap failed: ${res.failed}` });
    });

    api.get("/message/:uid", async (req, reply) => {
      const uid = Number((req.params as { uid: string }).uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        return reply.code(400).send({ error: "uid must be a positive integer" });
      }
      const res = await readMessage(ctx, req.user.sub, uid);
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      if ("notFound" in res) return reply.code(404).send({ error: "message not found" });
      if ("failed" in res) return reply.code(502).send({ error: `imap failed: ${res.failed}` });
      return res;
    });

    api.delete("/message/:uid", async (req, reply) => {
      const uid = Number((req.params as { uid: string }).uid);
      if (!Number.isInteger(uid) || uid <= 0) {
        return reply.code(400).send({ error: "uid must be a positive integer" });
      }
      const res = await deleteMessage(ctx, req.user.sub, uid);
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      if ("notFound" in res) return reply.code(404).send({ error: "message not found" });
      if ("failed" in res) return reply.code(502).send({ error: `imap failed: ${res.failed}` });
      return { deleted: true };
    });
  },
};
