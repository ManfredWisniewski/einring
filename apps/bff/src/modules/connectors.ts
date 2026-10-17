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
  /** Probe the upstream service with the would-be secret; return its HTTP status. */
  verify(fetchImpl: Fetch, url: string, secret: string): Promise<number>;
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
    return normalizeBase(raw.success ? raw.data : (opts.defaultUrl ?? ""));
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
    const status = await opts.verify(fetchImpl, url, secret.secret);
    if (status === 401 || status === 403)
      return reply.code(401).send({ error: "invalid credential" });
    if (status >= 400) {
      api.log.warn({ url, status }, `${opts.service} credential verify failed`);
      return reply.code(502).send({ error: `${opts.service} unreachable (${status})` });
    }
    store.saveServiceCredential({
      sub: req.user.sub,
      service: opts.service,
      url,
      secretSealed: secrets.seal(secret.secret),
    });
    return { connected: true, url };
  });

  api.delete("/credentials", async (req) => {
    store.deleteServiceCredential(req.user.sub, opts.service);
    return { connected: false };
  });
}
