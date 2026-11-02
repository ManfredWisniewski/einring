import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";
import type { AppContext } from "../../app.js";
import type { MailCred, MailMessage, MailResult, MailSummary } from "./types.js";

/** Minimal IMAP surface the module needs — injectable for tests via ctx.imapOpen. */
export interface ImapEnvelope {
  uid: number;
  envelope?: {
    subject?: string;
    date?: Date | string;
    from?: { name?: string; address?: string }[];
  };
}
export interface ImapMailbox {
  path: string;
  /** RFC 6154 special-use attribute, e.g. "\\Trash". */
  specialUse?: string;
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
  list(): AsyncIterable<ImapMailbox>;
  mailboxCreate(path: string): Promise<unknown>;
  /** Move into another mailbox — imapflow's messageMove (COPY + \Deleted + expunge). */
  messageMove(
    range: number | string,
    destination: string,
    opts: { uid: boolean },
  ): Promise<unknown>;
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

function slimFrom(from?: { name?: string; address?: string }[]) {
  const f = from?.[0];
  return { name: f?.name ?? null, address: f?.address ?? null };
}

async function withImap<T>(
  ctx: AppContext,
  cred: MailCred,
  fn: (client: ImapLike) => Promise<T>,
): Promise<T | { failed: string }> {
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

function parseUid(id: string): number | null {
  const uid = Number(id);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

export async function imapListRecent(
  ctx: AppContext,
  cred: MailCred,
): Promise<MailSummary[] | { failed: string }> {
  return withImap(ctx, cred, async (client) => {
    const total = client.mailbox === false ? 0 : client.mailbox.exists;
    if (!total) return [];
    const range = `${Math.max(1, total - LIST_LIMIT + 1)}:*`;
    const msgs: MailSummary[] = [];
    for await (const m of client.fetch(range, { envelope: true, uid: true })) {
      msgs.push({
        id: String(m.uid),
        subject: m.envelope?.subject ?? null,
        from: slimFrom(m.envelope?.from),
        date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : null,
      });
    }
    return msgs.reverse();
  });
}

export async function imapReadMessage(
  ctx: AppContext,
  cred: MailCred,
  id: string,
): Promise<MailResult<MailMessage>> {
  const uid = parseUid(id);
  if (uid === null) return { badId: true };
  return withImap(ctx, cred, async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (msg === false || !msg.source) return { notFound: true as const };
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

/** The \Trash special-use mailbox, creating a plain "Trash" when the server offers none. */
async function trashPath(client: ImapLike): Promise<string | null> {
  for await (const mb of client.list()) {
    if (mb.specialUse?.toLowerCase() === "\\trash") return mb.path;
  }
  try {
    await client.mailboxCreate("Trash");
    return "Trash";
  } catch {
    return null;
  }
}

export async function imapDeleteMessage(
  ctx: AppContext,
  cred: MailCred,
  id: string,
): Promise<MailResult<{ ok: true }>> {
  const uid = parseUid(id);
  if (uid === null) return { badId: true };
  return withImap(ctx, cred, async (client) => {
    const exists = await client.fetchOne(String(uid), { source: false }, { uid: true });
    if (exists === false) return { notFound: true as const };
    const trash = await trashPath(client);
    if (!trash) return { failed: "no trash mailbox" };
    await client.messageMove(String(uid), trash, { uid: true });
    return { ok: true as const };
  });
}

/** Credential-verify for the shared connector route: log in, log out. */
export async function imapVerify(
  ctx: AppContext,
  url: string,
  secretJson: string,
): Promise<number> {
  let secret: MailCred["secret"];
  try {
    secret = JSON.parse(secretJson) as MailCred["secret"];
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
}
