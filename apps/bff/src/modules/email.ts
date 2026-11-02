import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  type ConnectorOptions,
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

const LIST_LIMIT = 5;

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

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Connect-time resolve (D61): a bare host probes JMAP first (session + mail
 * capability), then IMAP — the winner's canonical url is what gets stored. An
 * explicit scheme verifies that backend directly. A JMAP 401 short-circuits:
 * a live endpoint rejected the credential, so IMAP would fail the same way.
 */
async function emailProbe(
  ctx: AppContext,
  raw: unknown,
  secretJson: string,
): Promise<{ url: string | null; status: number }> {
  if (typeof raw !== "string" || !raw.trim()) return { url: null, status: 400 };
  const s = raw.trim();
  if (HAS_SCHEME.test(s)) {
    const url = parseMailUrl(s);
    if (!url) return { url: null, status: 400 };
    const status =
      mailProtocol(url) === "jmap"
        ? await jmapVerify(ctx, url, secretJson)
        : await imapVerify(ctx, url, secretJson);
    return { url, status };
  }
  const jmapUrl = `https://${s}`;
  let status = await jmapVerify(ctx, jmapUrl, secretJson);
  if (status < 400) return { url: jmapUrl, status };
  // An answered 401 proves JMAP exists — the URL stays resolved so callers can
  // report the detected protocol; only the credential is wrong.
  if (status === 401 || status === 403) return { url: jmapUrl, status: 401 };
  const imapUrl = parseImapUrl(s);
  if (!imapUrl) return { url: null, status: 400 };
  status = await imapVerify(ctx, imapUrl, secretJson);
  return { url: imapUrl, status };
}

/** One connected mail account (D60): `email:<slug>` rows; the bare `email` row is "default". */
interface MailAccount extends MailCred {
  id: string;
  username: string;
}

/** Stable account id from login + host — re-adding the same account overwrites (update path). */
export function accountSlug(username: string, url: string): string {
  const host = new URL(url).hostname;
  return `${username}@${host}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function listAccounts(ctx: AppContext, sub: string): MailAccount[] {
  const out: MailAccount[] = [];
  for (const r of ctx.store.listServiceCredentials(sub, "email")) {
    if (r.service !== "email" && !r.service.startsWith("email:")) continue;
    if (!r.url) continue;
    const id = r.service === "email" ? "default" : r.service.slice("email:".length);
    try {
      const s = JSON.parse(ctx.secrets.open(r.secretSealed)) as MailCred["secret"];
      if (s.username && s.password) {
        out.push({ id, url: r.url, username: s.username, secret: s });
      }
    } catch {
      // Unparseable secret — skip the account rather than breaking the inbox.
    }
  }
  return out;
}

/**
 * Message ids are composite `accountId|messageId` (D60) — routes, EinHub dedupe
 * and chat tools stay single-value while disambiguating accounts.
 */
const composite = (accountId: string, msgId: string) => `${accountId}|${msgId}`;

function splitComposite(id: string): { accountId: string; msgId: string } | null {
  const i = id.indexOf("|");
  return i > 0 && i < id.length - 1 ? { accountId: id.slice(0, i), msgId: id.slice(i + 1) } : null;
}

async function listRecent(
  ctx: AppContext,
  sub: string,
): Promise<MailSummary[] | { notConnected: true } | { failed: string }> {
  const accounts = listAccounts(ctx, sub);
  if (!accounts.length) return { notConnected: true };
  const merged: MailSummary[] = [];
  for (const acc of accounts) {
    const res =
      mailProtocol(acc.url) === "jmap"
        ? await jmapListRecent(ctx, acc)
        : await imapListRecent(ctx, acc);
    // A broken account must not take the whole inbox down.
    if ("failed" in res) continue;
    for (const m of res) merged.push({ ...m, id: composite(acc.id, m.id), account: acc.id });
  }
  merged.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return merged.slice(0, LIST_LIMIT);
}

function accountFor(ctx: AppContext, sub: string, accountId: string): MailAccount | undefined {
  return listAccounts(ctx, sub).find((a) => a.id === accountId);
}

async function readMessage(
  ctx: AppContext,
  sub: string,
  id: string,
): Promise<MailResult<MailMessage>> {
  const c = splitComposite(id);
  if (!c) return { badId: true };
  if (!listAccounts(ctx, sub).length) return { notConnected: true };
  const acc = accountFor(ctx, sub, c.accountId);
  if (!acc) return { notFound: true };
  return mailProtocol(acc.url) === "jmap"
    ? jmapReadMessage(ctx, acc, c.msgId)
    : imapReadMessage(ctx, acc, c.msgId);
}

async function deleteMessage(
  ctx: AppContext,
  sub: string,
  id: string,
): Promise<MailResult<{ ok: true }>> {
  const c = splitComposite(id);
  if (!c) return { badId: true };
  if (!listAccounts(ctx, sub).length) return { notConnected: true };
  const acc = accountFor(ctx, sub, c.accountId);
  if (!acc) return { notFound: true };
  return mailProtocol(acc.url) === "jmap"
    ? jmapDeleteMessage(ctx, acc, c.msgId)
    : imapDeleteMessage(ctx, acc, c.msgId);
}

export const emailModule: BffModule<EmailConfig> = {
  id: "email",
  configSchema,

  notifications(ctx) {
    return {
      // New INBOX messages → einhub items; dedupe by composite message id.
      async poll(sub) {
        const res = await listRecent(ctx, sub);
        if (!Array.isArray(res)) return [];
        return res.map((m) => ({
          sourceId: m.id,
          title: m.subject ?? "(no subject)",
          body: m.from?.name ?? m.from?.address ?? m.account,
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
          "List the user's 5 most recent inbox emails across all mail accounts (id, account, subject, sender, date). Use for 'any new mail?' questions.",
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
      resolve: (raw, secretJson) => emailProbe(ctx, raw, secretJson),
    };
    registerConnectorRoutes(api, ctx, options);

    // Multi-account API (D60). The legacy /credentials route manages the "default" account.
    // Protocol detection (D61): probe a bare server without storing — JMAP
    // first, then IMAP. A 401 still counts as detected (endpoint exists).
    api.post("/probe", async (req, reply) => {
      const body = z
        .object({
          username: z.string().min(1),
          password: z.string().min(1),
          url: z.string().min(1),
        })
        .safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "expected {username, password, url}" });
      }
      const r = await emailProbe(
        ctx,
        body.data.url,
        JSON.stringify({ username: body.data.username, password: body.data.password }),
      );
      if (r.status === 400) return reply.code(400).send({ error: "invalid server" });
      // Detected = an endpoint answered, even with an auth rejection.
      if (!r.url || (r.status >= 400 && r.status !== 401)) {
        return reply.code(502).send({ error: "no mail service detected" });
      }
      return { protocol: mailProtocol(r.url), url: r.url };
    });

    api.get("/accounts", async (req) => ({
      accounts: listAccounts(ctx, req.user.sub).map(({ id, username, url }) => ({
        id,
        username,
        url,
      })),
    }));

    api.post("/accounts", async (req, reply) => {
      const body = z
        .object({
          username: z.string().min(1),
          password: z.string().min(1),
          url: z.string().optional(),
        })
        .safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "expected {username, password, url?}" });
      }
      const secretJson = JSON.stringify({
        username: body.data.username,
        password: body.data.password,
      });
      const { url, status } = await emailProbe(ctx, body.data.url ?? config.URL, secretJson);
      if (status === 400) return reply.code(400).send({ error: "no email url configured" });
      if (status === 401 || status === 403) {
        return reply.code(401).send({ error: "invalid credential" });
      }
      if (status >= 400 || !url) {
        api.log.warn({ url: body.data.url, status }, "email account verify failed");
        return reply.code(502).send({ error: `email unreachable (${status})` });
      }
      const id = accountSlug(body.data.username, url);
      ctx.store.saveServiceCredential({
        sub: req.user.sub,
        service: `email:${id}`,
        url,
        secretSealed: ctx.secrets.seal(secretJson),
      });
      return { id, connected: true, url };
    });

    api.delete("/accounts/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const service = id === "default" ? "email" : `email:${id}`;
      if (!ctx.store.getServiceCredential(req.user.sub, service)) {
        return reply.code(404).send({ error: "account not found" });
      }
      ctx.store.deleteServiceCredential(req.user.sub, service);
      return { deleted: true };
    });

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
