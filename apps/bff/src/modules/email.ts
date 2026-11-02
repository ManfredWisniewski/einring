import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  type ConnectorOptions,
  connectorCred,
  normalizeBase,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import {
  imapDeleteMessage,
  imapListRecent,
  imapReadMessage,
  imapVerify,
  parseImapUrl,
} from "./email/imap.js";
import { jmapDeleteMessage, jmapListRecent, jmapReadMessage, jmapVerify } from "./email/jmap.js";
import type { MailCred, MailMessage, MailResult, MailSummary } from "./email/types.js";
import type { BffModule, ChatTool } from "./types.js";

export type { ImapOpen } from "./email/imap.js";

const configSchema = z.object({
  /** Default mail server (imaps://host:993, bare host[:port] or jmap://host); the connect form may override it. */
  URL: z.string().optional(),
});
type EmailConfig = z.infer<typeof configSchema>;

/**
 * Canonical mail connector URL. IMAP: `imaps://`/`imap://`/bare `host[:port]`
 * (unchanged default). JMAP: `jmap://host` (→ `https://`) or `http(s)://`.
 * The stored scheme picks the backend (D58).
 */
export function parseMailUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const http = /^jmap:\/\//i.test(s)
    ? `https://${s.replace(/^jmap:\/\//i, "")}`
    : /^https?:\/\//i.test(s)
      ? s
      : null;
  if (http !== null) {
    try {
      const u = new URL(http);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.hostname ? normalizeBase(`${u.origin}${u.pathname}`) : null;
    } catch {
      return null;
    }
  }
  return parseImapUrl(s);
}

/** Stored url → backend. IMAP urls are `imap(s)://`; everything else is JMAP-over-HTTP. */
function mailProtocol(url: string): "imap" | "jmap" {
  return url.startsWith("http") ? "jmap" : "imap";
}

function credFor(ctx: AppContext, sub: string): MailCred | null {
  const c = connectorCred(ctx, sub, "email");
  if (!c) return null;
  try {
    const s = JSON.parse(c.secret) as MailCred["secret"];
    return s.username && s.password ? { url: c.url, secret: s } : null;
  } catch {
    return null;
  }
}

async function listRecent(
  ctx: AppContext,
  sub: string,
): Promise<MailSummary[] | { notConnected: true } | { failed: string }> {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true };
  return mailProtocol(cred.url) === "jmap" ? jmapListRecent(ctx, cred) : imapListRecent(ctx, cred);
}

async function readMessage(
  ctx: AppContext,
  sub: string,
  id: string,
): Promise<MailResult<MailMessage>> {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true };
  return mailProtocol(cred.url) === "jmap"
    ? jmapReadMessage(ctx, cred, id)
    : imapReadMessage(ctx, cred, id);
}

async function deleteMessage(
  ctx: AppContext,
  sub: string,
  id: string,
): Promise<MailResult<{ ok: true }>> {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true };
  return mailProtocol(cred.url) === "jmap"
    ? jmapDeleteMessage(ctx, cred, id)
    : imapDeleteMessage(ctx, cred, id);
}

export const emailModule: BffModule<EmailConfig> = {
  id: "email",
  configSchema,

  notifications(ctx) {
    return {
      // New INBOX messages → einhub items; dedupe by message id.
      async poll(sub) {
        const res = await listRecent(ctx, sub);
        if (!Array.isArray(res)) return [];
        return res.map((m) => ({
          sourceId: m.id,
          title: m.subject ?? "(no subject)",
          body: m.from?.name ?? m.from?.address ?? undefined,
          at: m.date ?? undefined,
        }));
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "email_recent",
        description:
          "List the user's 5 most recent inbox emails (id, subject, sender, date). Use for 'any new mail?' questions.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const res = await listRecent(ctx, sub);
          if (!Array.isArray(res)) {
            return "notConnected" in res
              ? { error: "not_connected" }
              : { error: `mail failed: ${res.failed}` };
          }
          return { emails: res };
        },
      },
      {
        name: "email_read",
        description: "Read one email's full text content. Needs the id from email_recent.",
        parameters: {
          type: "object",
          properties: { id: { type: "string", description: "Message id from email_recent" } },
          required: ["id"],
        },
        async call(args, sub) {
          const id = typeof args.id === "string" ? args.id : String(args.id ?? "");
          const res = await readMessage(ctx, sub, id);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("badId" in res) return { error: "invalid message id" };
          if ("notFound" in res) return { error: "not found" };
          if ("failed" in res) return { error: `mail failed: ${res.failed}` };
          // The LLM doesn't need raw HTML when text exists.
          return { ...res, html: res.text ? null : res.html };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "email",
      defaultUrl: config.URL ? (parseMailUrl(config.URL) ?? undefined) : undefined,
      parseSecret: userPassSecret,
      parseUrl: parseMailUrl,
      verify: async (_fetchImpl, url, secretJson) =>
        mailProtocol(url) === "jmap"
          ? jmapVerify(ctx, url, secretJson)
          : imapVerify(ctx, url, secretJson),
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/list", async (req, reply) => {
      const res = await listRecent(ctx, req.user.sub);
      if (Array.isArray(res)) return { emails: res };
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      return reply.code(502).send({ error: `mail failed: ${res.failed}` });
    });

    api.get("/message/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await readMessage(ctx, req.user.sub, id);
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      if ("badId" in res) return reply.code(400).send({ error: "invalid message id" });
      if ("notFound" in res) return reply.code(404).send({ error: "message not found" });
      if ("failed" in res) return reply.code(502).send({ error: `mail failed: ${res.failed}` });
      return res;
    });

    api.delete("/message/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const res = await deleteMessage(ctx, req.user.sub, id);
      if ("notConnected" in res) {
        return reply.code(424).send({ error: "email is not connected" });
      }
      if ("badId" in res) return reply.code(400).send({ error: "invalid message id" });
      if ("notFound" in res) return reply.code(404).send({ error: "message not found" });
      if ("failed" in res) return reply.code(502).send({ error: `mail failed: ${res.failed}` });
      return { deleted: true };
    });
  },
};
