import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
  /** Authentik group memberships (D56) — only present on JWTs, never on embedded sessions. */
  groups?: string[];
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser;
  }
}

/** Validates Authentik access tokens (JWT) against the issuer's JWKS. */
export async function createAuthentikVerifier(
  issuer: string,
  clientId: string,
): Promise<TokenVerifier> {
  const discoveryUrl = new URL(".well-known/openid-configuration", issuer.replace(/\/?$/, "/"));
  const res = await fetch(discoveryUrl);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${discoveryUrl}`);
  const discovery = (await res.json()) as { issuer: string; jwks_uri: string };
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));

  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: discovery.issuer,
      audience: clientId,
    });
    if (!payload.sub) throw new Error("token has no sub");
    return {
      sub: payload.sub,
      name: str(payload.name),
      email: str(payload.email),
      preferredUsername: str(payload.preferred_username),
      groups: Array.isArray(payload.groups)
        ? payload.groups.filter((g): g is string => typeof g === "string")
        : undefined,
    };
  };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Verifies opaque einring session tokens (embedded mode, D19 amendment) — the token
 * itself is never stored, only its sha256 hash maps to a `sub`.
 */
export function createSessionVerifier(
  getSessionSub: (tokenHash: string) => string | undefined,
): TokenVerifier {
  return async (token) => {
    const sub = getSessionSub(hashToken(token));
    if (!sub) throw new Error("unknown session token");
    return { sub };
  };
}

/** Tries each verifier in order; the first success wins. */
export function createCompositeVerifier(...verifiers: TokenVerifier[]): TokenVerifier {
  return async (token) => {
    let lastErr: unknown;
    for (const verify of verifiers) {
      try {
        return await verify(token);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("invalid token");
  };
}

export function requireAuth(verify: TokenVerifier) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    try {
      request.user = await verify(token);
    } catch (err) {
      let tokenAlg: string | undefined;
      let tokenKid: string | undefined;
      try {
        const header = JSON.parse(
          Buffer.from(token.split(".")[0] ?? "", "base64url").toString(),
        ) as { alg?: string; kid?: string };
        tokenAlg = header.alg;
        tokenKid = header.kid;
      } catch {
        // opaque token — nothing to decode
      }
      request.log.warn({ err, tokenAlg, tokenKid }, "token rejected");
      return reply.code(401).send({ error: "invalid token" });
    }
  };
}
