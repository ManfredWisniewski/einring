import type { AppContext } from "../../app.js";
import { normalizeBase } from "../connectors.js";
import type { MailCred, MailMessage, MailResult, MailSummary } from "./types.js";

/**
 * JMAP backend (RFC 8620/8621) — plain fetch, no client library (D58).
 * Auth: HTTP Basic with the stored username+password; Stalwart accepts app passwords.
 */

const JMAP_CORE = "urn:ietf:params:jmap:core";
const JMAP_MAIL = "urn:ietf:params:jmap:mail";
const LIST_LIMIT = 5;

interface JmapSession {
  apiUrl: string;
  accounts: Record<string, unknown>;
  primaryAccounts?: Record<string, string>;
  capabilities: Record<string, unknown>;
}

/** Resolved session: where to POST + which account + auth header. */
interface JmapCtx {
  apiUrl: string;
  accountId: string;
  auth: string;
}

function basicAuth(cred: MailCred): string {
  return `Basic ${Buffer.from(`${cred.secret.username}:${cred.secret.password}`).toString("base64")}`;
}

/** GET <base>/.well-known/jmap → session resource (the 307 to /jmap/session is followed). */
async function jmapSession(ctx: AppContext, cred: MailCred): Promise<JmapCtx | { failed: string }> {
  const f = ctx.fetchImpl ?? fetch;
  const auth = basicAuth(cred);
  let res: Response;
  try {
    res = await f(`${normalizeBase(cred.url)}/.well-known/jmap`, {
      headers: { Accept: "application/json", Authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { failed: err instanceof Error ? err.message : "jmap session failed" };
  }
  if (!res.ok) return { failed: `jmap session ${res.status}` };
  const s = (await res.json().catch(() => null)) as JmapSession | null;
  if (!s?.apiUrl) return { failed: "invalid jmap session" };
  const accountId = s.primaryAccounts?.[JMAP_MAIL] ?? Object.keys(s.accounts ?? {})[0];
  if (!accountId) return { failed: "no jmap mail account" };
  return { apiUrl: s.apiUrl, accountId, auth };
}

type MethodCall = [string, Record<string, unknown>, string];

/** Type guard: `in` alone can't discriminate Record unions — callIds never collide with "failed". */
function isFailed<T>(r: T | { failed: string }): r is { failed: string } {
  return typeof r === "object" && r !== null && "failed" in r;
}

async function jmapCall(
  ctx: AppContext,
  sesh: JmapCtx,
  calls: MethodCall[],
): Promise<Record<string, Record<string, unknown>> | { failed: string }> {
  const f = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(sesh.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: sesh.auth,
      },
      body: JSON.stringify({ using: [JMAP_CORE, JMAP_MAIL], methodCalls: calls }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { failed: err instanceof Error ? err.message : "jmap request failed" };
  }
  if (!res.ok) return { failed: `jmap ${res.status}` };
  const body = (await res.json().catch(() => null)) as {
    methodResponses?: [string, Record<string, unknown>, string][];
  } | null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [, data, callId] of body?.methodResponses ?? []) out[callId] = data;
  return out;
}

async function withJmap<T>(
  ctx: AppContext,
  cred: MailCred,
  fn: (sesh: JmapCtx) => Promise<T>,
): Promise<T | { failed: string }> {
  const sesh = await jmapSession(ctx, cred);
  if (isFailed(sesh)) return sesh;
  return fn(sesh);
}

/** Mailbox/get → the mailbox id carrying `role` ("inbox", "trash"), or null. */
async function mailboxByRole(
  ctx: AppContext,
  sesh: JmapCtx,
  role: string,
): Promise<string | null | { failed: string }> {
  const r = await jmapCall(ctx, sesh, [
    ["Mailbox/get", { accountId: sesh.accountId, properties: ["id", "role"] }, "mb"],
  ]);
  if (isFailed(r)) return r;
  const list = (r.mb?.list ?? []) as { id: string; role?: string }[];
  return list.find((m) => m.role === role)?.id ?? null;
}

interface JmapEmail {
  id: string;
  subject?: string | null;
  from?: { name?: string; email?: string }[];
  receivedAt?: string;
  textBody?: { partId: string }[];
  htmlBody?: { partId: string }[];
  bodyValues?: Record<string, { value?: string }>;
}

function slimFrom(from?: { name?: string; email?: string }[]) {
  const f = from?.[0];
  return { name: f?.name ?? null, address: f?.email ?? null };
}

/** Concatenate textBody/htmlBody parts via bodyValues — the JMAP counterpart of postal-mime. */
function joinParts(
  parts: { partId: string }[] | undefined,
  values: Record<string, { value?: string }> | undefined,
): string | null {
  if (!parts?.length || !values) return null;
  const s = parts.map((p) => values[p.partId]?.value ?? "").join("");
  return s || null;
}

export async function jmapListRecent(
  ctx: AppContext,
  cred: MailCred,
): Promise<MailSummary[] | { failed: string }> {
  return withJmap(ctx, cred, async (sesh) => {
    const inboxId = await mailboxByRole(ctx, sesh, "inbox");
    if (isFailed(inboxId)) return inboxId;
    if (!inboxId) return { failed: "no inbox mailbox" };
    const r = await jmapCall(ctx, sesh, [
      [
        "Email/query",
        {
          accountId: sesh.accountId,
          filter: { inMailbox: inboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          position: 0,
          limit: LIST_LIMIT,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: sesh.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["id", "subject", "from", "receivedAt"],
        },
        "e",
      ],
    ]);
    if (isFailed(r)) return r;
    const list = (r.e?.list ?? []) as JmapEmail[];
    return list.map((e) => ({
      id: e.id,
      subject: e.subject ?? null,
      from: slimFrom(e.from),
      date: e.receivedAt ?? null,
    }));
  });
}

export async function jmapReadMessage(
  ctx: AppContext,
  cred: MailCred,
  id: string,
): Promise<MailResult<MailMessage>> {
  if (!id.trim()) return { badId: true };
  return withJmap(ctx, cred, async (sesh) => {
    const r = await jmapCall(ctx, sesh, [
      [
        "Email/get",
        {
          accountId: sesh.accountId,
          ids: [id],
          properties: ["id", "subject", "from", "receivedAt", "textBody", "htmlBody", "bodyValues"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        "e",
      ],
    ]);
    if (isFailed(r)) return r;
    const res = r.e as { list?: JmapEmail[]; notFound?: string[] } | undefined;
    const m = res?.list?.[0];
    if (!m || res?.notFound?.includes(id)) return { notFound: true as const };
    return {
      subject: m.subject ?? null,
      from: slimFrom(m.from),
      date: m.receivedAt ?? null,
      text: joinParts(m.textBody, m.bodyValues),
      html: joinParts(m.htmlBody, m.bodyValues),
    };
  });
}

/** Move to Trash (D58): mailboxIds wholesale-replaced with the role:"trash" mailbox. */
export async function jmapDeleteMessage(
  ctx: AppContext,
  cred: MailCred,
  id: string,
): Promise<MailResult<{ ok: true }>> {
  if (!id.trim()) return { badId: true };
  return withJmap(ctx, cred, async (sesh) => {
    const trashId = await mailboxByRole(ctx, sesh, "trash");
    if (isFailed(trashId)) return trashId;
    if (!trashId) return { failed: "no trash mailbox" };
    const r = await jmapCall(ctx, sesh, [
      [
        "Email/set",
        { accountId: sesh.accountId, update: { [id]: { mailboxIds: { [trashId]: true } } } },
        "s",
      ],
    ]);
    if (isFailed(r)) return r;
    const s = r.s as
      | { updated?: Record<string, unknown>; notUpdated?: Record<string, { type?: string }> }
      | undefined;
    const err = s?.notUpdated?.[id];
    if (err) {
      return err.type === "notFound"
        ? { notFound: true as const }
        : { failed: `email set: ${err.type ?? "error"}` };
    }
    return { ok: true as const };
  });
}

/** Credential-verify for the shared connector route: session + mail capability. */
export async function jmapVerify(
  ctx: AppContext,
  url: string,
  secretJson: string,
): Promise<number> {
  let secret: MailCred["secret"];
  try {
    secret = JSON.parse(secretJson) as MailCred["secret"];
    if (!secret.username || !secret.password) return 400;
  } catch {
    return 400;
  }
  const f = ctx.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${normalizeBase(url)}/.well-known/jmap`, {
      headers: {
        Accept: "application/json",
        Authorization: basicAuth({ url, secret }),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return 502;
  }
  if (res.status === 401 || res.status === 403) return 401;
  if (!res.ok) return 502;
  const s = (await res.json().catch(() => null)) as JmapSession | null;
  return s?.capabilities?.[JMAP_MAIL] ? 200 : 502;
}
