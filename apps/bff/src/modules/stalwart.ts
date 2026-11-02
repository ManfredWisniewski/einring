import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  type ConnectorOptions,
  connectorCred,
  normalizeBase,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default Stalwart server (https://host); the connect form may override it. */
  URL: z.string().optional(),
});
type StalwartConfig = z.infer<typeof configSchema>;

const JMAP_CORE = "urn:ietf:params:jmap:core";
const JMAP_PRINCIPALS = "urn:ietf:params:jmap:principals";

interface JmapSession {
  apiUrl: string;
  capabilities: Record<string, unknown>;
  accounts?: Record<string, unknown>;
}

interface StalwartCred {
  url: string;
  secret: { username: string; password: string };
}

interface StalwartCtx extends StalwartCred {
  apiUrl: string;
  auth: string;
}

function basicAuth(secret: StalwartCred["secret"]): string {
  return `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString("base64")}`;
}

function cred(ctx: AppContext, sub: string): StalwartCred | null {
  const c = connectorCred(ctx, sub, "stalwart");
  if (!c) return null;
  try {
    const secret = JSON.parse(c.secret) as StalwartCred["secret"];
    return secret.username && secret.password ? { url: c.url, secret } : null;
  } catch {
    return null;
  }
}

/** GET <base>/.well-known/jmap → session resource (redirect is followed). */
async function session(
  ctx: AppContext,
  c: StalwartCred,
): Promise<(JmapSession & { auth: string }) | { failed: string }> {
  const f = ctx.fetchImpl ?? fetch;
  const auth = basicAuth(c.secret);
  let res: Response;
  try {
    res = await f(`${normalizeBase(c.url)}/.well-known/jmap`, {
      headers: { Accept: "application/json", Authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { failed: err instanceof Error ? err.message : "session failed" };
  }
  if (!res.ok) return { failed: `session ${res.status}` };
  const s = (await res.json().catch(() => null)) as JmapSession | null;
  if (!s?.apiUrl) return { failed: "invalid session" };
  return { ...s, auth };
}

function isFailed<T>(r: T | { failed: string }): r is { failed: string } {
  return typeof r === "object" && r !== null && "failed" in r;
}

type MethodCall = [string, Record<string, unknown>, string];

/** POST apiUrl — read-only method calls only (D62: no set-methods, no uploads). */
async function jmapCall(
  ctx: AppContext,
  sesh: StalwartCtx,
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
      body: JSON.stringify({ using: [JMAP_CORE, JMAP_PRINCIPALS], methodCalls: calls }),
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

interface Principal {
  id: string;
  type?: string;
  name?: string | null;
  email?: string | null;
  description?: string | null;
}

export interface StalwartPrincipals {
  accounts: Principal[];
  groups: Principal[];
  lists: Principal[];
  roles: Principal[];
  domains: Principal[];
  mailDomains: { id: string; name: string }[];
}

const slim = (p: Principal) => ({
  id: p.id,
  name: p.name ?? null,
  email: p.email ?? null,
  description: p.description ?? null,
});

async function principals(
  ctx: AppContext,
  c: StalwartCred,
): Promise<StalwartPrincipals | { failed: string }> {
  const s = await session(ctx, c);
  if (isFailed(s)) return s;
  const sesh: StalwartCtx = { ...c, apiUrl: s.apiUrl, auth: s.auth };
  const r = await jmapCall(ctx, sesh, [
    ["Principal/query", {}, "pq"],
    ["Principal/get", { "#ids": { resultOf: "pq", name: "Principal/query", path: "/ids" } }, "pg"],
    ["Domain/query", {}, "dq"],
    ["Domain/get", { "#ids": { resultOf: "dq", name: "Domain/query", path: "/ids" } }, "dg"],
  ]);
  if (isFailed(r)) return r;
  const byType = (t: string) =>
    ((r.pg?.list ?? []) as Principal[]).filter((p) => p.type === t).map(slim);
  const mailDomains = ((r.dg?.list ?? []) as { id: string; name?: string }[]).map((d) => ({
    id: d.id,
    name: d.name ?? d.id,
  }));
  return {
    accounts: byType("individual"),
    groups: byType("group"),
    lists: byType("list"),
    roles: byType("role"),
    domains: byType("domain"),
    mailDomains,
  };
}

async function info(
  ctx: AppContext,
  c: StalwartCred,
): Promise<{ capabilities: string[]; apiUrl: string; accountIds: string[] } | { failed: string }> {
  const s = await session(ctx, c);
  if (isFailed(s)) return s;
  return {
    capabilities: Object.keys(s.capabilities ?? {}),
    apiUrl: s.apiUrl,
    accountIds: Object.keys(s.accounts ?? {}),
  };
}

export const stalwartModule: BffModule<StalwartConfig> = {
  id: "stalwart",
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "stalwart_info",
        description:
          "Show the connected Stalwart mail server's capabilities and reachable account ids (server info, not mail content).",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const c = cred(ctx, sub);
          if (!c) return { error: "not_connected" };
          const res = await info(ctx, c);
          if (isFailed(res)) return { error: `stalwart failed: ${res.failed}` };
          return res;
        },
      },
      {
        name: "stalwart_principals",
        description:
          "List mail accounts, groups, mailing lists, roles and domains configured on the Stalwart server.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const c = cred(ctx, sub);
          if (!c) return { error: "not_connected" };
          const res = await principals(ctx, c);
          if (isFailed(res)) return { error: `stalwart failed: ${res.failed}` };
          return res;
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "stalwart",
      defaultUrl: config.URL,
      parseSecret: userPassSecret,
      verify: async (fetchImpl, url, secretJson) => {
        const f = fetchImpl;
        let secret: StalwartCred["secret"];
        try {
          secret = JSON.parse(secretJson) as StalwartCred["secret"];
        } catch {
          return 400;
        }
        let res: Response;
        try {
          res = await f(`${normalizeBase(url)}/.well-known/jmap`, {
            headers: { Accept: "application/json", Authorization: basicAuth(secret) },
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          return 502;
        }
        if (res.status === 401 || res.status === 403) return 401;
        if (!res.ok) return 502;
        const s = (await res.json().catch(() => null)) as JmapSession | null;
        return s?.capabilities?.[JMAP_PRINCIPALS] ? 200 : 502;
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/info", async (req, reply) => {
      const c = cred(ctx, req.user.sub);
      if (!c) return reply.code(424).send({ error: "stalwart is not connected" });
      const res = await info(ctx, c);
      if (isFailed(res)) return reply.code(502).send({ error: res.failed });
      return res;
    });

    api.get("/principals", async (req, reply) => {
      const c = cred(ctx, req.user.sub);
      if (!c) return reply.code(424).send({ error: "stalwart is not connected" });
      const res = await principals(ctx, c);
      if (isFailed(res)) return reply.code(502).send({ error: res.failed });
      return res;
    });
  },
};
