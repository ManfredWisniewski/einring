import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Fetch } from "../nextcloud/client.js";

/** Common shape of the connector-module credential routes (D41). */

export interface ConnectorOptions {
  /** service_credentials row key — the module id. */
  service: string;
  /** Deployment default instance URL; the connect form may override it. */
  defaultUrl?: string;
  /**
   * Validate the POST body → the secret to seal. For apiKey connectors the
   * secret is the key; for username+password connectors a JSON blob.
   * Return {error} on bad input → 400.
   */
  parseSecret(body: unknown): { secret: string } | { error: string };
  /**
   * Override URL handling (default: `z.url()` on body.url, else defaultUrl).
   * For non-HTTP connectors (e.g. IMAP hosts) return the normalized address or
   * null → 400. `raw` is the body's url field.
   */
  parseUrl?(raw: unknown): string | null;
  /**
   * Probe the upstream service with the would-be secret. Return either a bare
   * HTTP status or `{status, secret}` — the latter replaces what gets sealed
   * (e.g. Gotify exchanges user+password for a client token).
   */
  verify(
    fetchImpl: Fetch,
    url: string,
    secret: string,
  ): Promise<number | { status: number; secret?: string }>;
  /** Best-effort upstream cleanup before the local credential row is deleted. */
  onDisconnect?(fetchImpl: Fetch, url: string, secret: string): Promise<void>;
}

/** Single API-key body: {apiKey, url?}. */
export function apiKeySecret(body: unknown): { secret: string } | { error: string } {
  const parsed = z.object({ apiKey: z.string().min(1) }).safeParse(body);
  return parsed.success ? { secret: parsed.data.apiKey } : { error: "expected {apiKey, url?}" };
}

/** Username+password body: {username, password, url?} — stored as JSON (sealed). */
export function userPassSecret(body: unknown): { secret: string } | { error: string } {
  const parsed = z
    .object({ username: z.string().min(1), password: z.string().min(1) })
    .safeParse(body);
  return parsed.success
    ? { secret: JSON.stringify({ username: parsed.data.username, password: parsed.data.password }) }
    : { error: "expected {username, password, url?}" };
}

export const connectorUrlSchema = z.url();

export function normalizeBase(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A stored connector credential with the secret opened. Null when absent. */
export function connectorCred(
  ctx: AppContext,
  sub: string,
  service: string,
): { url: string; secret: string } | null {
  const c = ctx.store.getServiceCredential(sub, service);
  return c?.url ? { url: c.url, secret: ctx.secrets.open(c.secretSealed) } : null;
}

/** Authenticated GET against a connector instance; returns status + parsed body. */
export async function connectorGet<T>(
  fetchImpl: Fetch,
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(`${normalizeBase(baseUrl)}${path}`, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * Mounts the standard connector routes on a module's `/api/<service>` prefix:
 * GET /status, POST /credentials (verify → seal → store), DELETE /credentials.
 */
export function registerConnectorRoutes(
  api: FastifyInstance,
  ctx: AppContext,
  opts: ConnectorOptions,
): void {
  const { store, secrets } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const urlOf = (body: unknown) => {
    if (opts.parseUrl) {
      return opts.parseUrl((body as { url?: unknown })?.url ?? opts.defaultUrl) ?? "";
    }
    const raw = connectorUrlSchema.safeParse((body as { url?: unknown })?.url);
    if (!raw.success) return normalizeBase(opts.defaultUrl ?? "");
    // Base URL only: drop query and fragment — they break path concatenation
    // ("https://host/#" + "/client" would never resolve).
    try {
      const u = new URL(raw.data);
      return normalizeBase(`${u.origin}${u.pathname}`);
    } catch {
      return normalizeBase(raw.data);
    }
  };

  api.get("/status", async (req) => {
    const cred = store.getServiceCredential(req.user.sub, opts.service);
    return { connected: cred !== undefined, url: cred?.url ?? opts.defaultUrl ?? null };
  });

  api.post("/credentials", async (req, reply) => {
    const secret = opts.parseSecret(req.body);
    if ("error" in secret) return reply.code(400).send({ error: secret.error });
    const url = urlOf(req.body);
    if (!url) return reply.code(400).send({ error: `no ${opts.service} url configured` });
    const verified = await opts.verify(fetchImpl, url, secret.secret);
    const status = typeof verified === "number" ? verified : verified.status;
    if (status === 401 || status === 403)
      return reply.code(401).send({ error: "invalid credential" });
    if (status >= 400) {
      api.log.warn({ url, status }, `${opts.service} credential verify failed`);
      return reply.code(502).send({ error: `${opts.service} unreachable (${status})` });
    }
    const finalSecret =
      typeof verified === "object" && verified.secret ? verified.secret : secret.secret;
    // Revoke the superseded credential upstream — otherwise the old token stays live.
    const old = connectorCred(ctx, req.user.sub, opts.service);
    if (old && opts.onDisconnect) {
      await opts.onDisconnect(fetchImpl, old.url, old.secret).catch((err) => {
        api.log.warn({ err, service: opts.service }, "credential revoke on overwrite failed");
      });
    }
    store.saveServiceCredential({
      sub: req.user.sub,
      service: opts.service,
      url,
      secretSealed: secrets.seal(finalSecret),
    });
    return { connected: true, url };
  });

  api.delete("/credentials", async (req, reply) => {
    if (opts.onDisconnect) {
      const cred = connectorCred(ctx, req.user.sub, opts.service);
      if (cred) {
        try {
          await opts.onDisconnect(fetchImpl, cred.url, cred.secret);
        } catch (err) {
          // Surface the failure — a silently orphaned token stays valid upstream.
          api.log.warn({ err, service: opts.service }, "credential revoke failed");
          return reply.code(502).send({ error: `${opts.service} revocation failed` });
        }
      }
    }
    store.deleteServiceCredential(req.user.sub, opts.service);
    return { connected: false };
  });
}
