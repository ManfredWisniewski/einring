import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { type AuthUser, hashToken } from "../auth.js";
import type { NextcloudCredential } from "../db.js";
import { makeRateLimiter } from "../rate-limit.js";

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | { status: "awaiting_claim" }
  | {
      status: "connected";
      loginName: string;
      displayName: string | null;
      server: string;
      /** Present only when an anonymous (embedded) flow completes: the einring session token. */
      sessionToken?: string;
    };

/** Pending flows are keyed `flow:<id>` so no real `sub` is touched. */
const FLOW_SUB_PREFIX = "flow:";
/** Credential identity for sessions minted in embedded mode. */
const EMBEDDED_SUB_PREFIX = "nc:";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CLAIM_ATTEMPTS = 5;

const flowStartLimit = makeRateLimiter(10, 10 * 60_000);
const flowPollLimit = makeRateLimiter(60, 60_000);
const flowClaimLimit = makeRateLimiter(30, 60_000);
/** Wrong-code attempts per flow id; the flow dies after MAX_CLAIM_ATTEMPTS. */
const claimAttempts = new Map<string, number>();

/**
 * Nextcloud Login Flow v2, held server-side so the app password never reaches the client.
 *
 *   POST   /api/nextcloud/login-flow        -> { login, flow }                   (auth optional)
 *   POST   /api/nextcloud/login-flow/poll   -> pending | awaiting_claim          (auth optional)
 *   POST   /api/nextcloud/login-flow/claim  -> connected(+sessionToken?)         (auth optional)
 *   GET    /api/nextcloud/connection        -> ConnectionStatus                  (auth)
 *   DELETE /api/nextcloud/connection        -> 204, drops credential + sessions  (auth)
 *
 * The flow is deliberately completer-bound: once upstream login succeeds, the BFF
 * parks the app password on the flow and writes a 6-digit claim code into the
 * completing user's own Nextcloud files (`einring-sign-in-<code>.txt`). Only a
 * caller presenting that code receives the credential — an attacker who merely
 * initiated the flow and knows its id gains nothing, because the code only ever
 * exists inside the victim's own account. Authentik-authed claimers get the
 * credential under their sub; anonymous (embedded) claimers get a session.
 */

/** Fetches the account's display name once and stores it on the credential. */
async function resolveDisplayName(
  ctx: AppContext,
  cred: NextcloudCredential,
): Promise<string | null> {
  const { store, secrets, nextcloud } = ctx;
  if (cred.displayName) return cred.displayName;
  try {
    const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
    const name = (await nc.getOwnUser()).ocs.data.displayname ?? null;
    if (name) store.saveCredential({ ...cred, displayName: name });
    return name;
  } catch {
    return null;
  }
}

/** Best-effort upstream revocation of a stored app password. */
async function revokeCredential(
  ctx: AppContext,
  cred: NextcloudCredential,
  log: FastifyBaseLogger,
) {
  try {
    const nc = ctx.nextcloud.withCredentials(
      cred.loginName,
      ctx.secrets.open(cred.appPasswordSealed),
    );
    await nc.deleteAppPassword();
  } catch (err) {
    log.warn({ err }, "nextcloud app-password revocation failed");
  }
}

/** Bearer token if it verifies (Authentik JWT or einring session), else undefined. */
async function optionalUser(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<AuthUser | undefined> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return undefined;
  try {
    return await ctx.verifyToken(token);
  } catch {
    return undefined;
  }
}

const claimFileName = (code: string) => `einring-sign-in-${code}.txt`;

const claimFileBody = (code: string) =>
  `Einring sign-in code: ${code}\n\n` +
  `Enter this code in the einring app to finish connecting your account.\n` +
  `If you did not try to sign in, delete this file.\n`;

const codeMatches = (claimHash: string, code: string) => {
  const a = Buffer.from(claimHash, "hex");
  const b = createHash("sha256").update(code).digest();
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Public scope — registered WITHOUT requireAuth; anonymous callers use a `flow` id. */
export function registerNextcloudPublicRoutes(api: FastifyInstance, ctx: AppContext) {
  const { store, secrets, nextcloud } = ctx;

  api.post("/nextcloud/login-flow", async (request, reply) => {
    if (!flowStartLimit.allow(request.ip)) {
      return reply.code(429).send({ error: "too many requests" });
    }
    const user = await optionalUser(ctx, request);
    const flow = await nextcloud.startLoginFlow();
    const flowId = randomBytes(16).toString("base64url");
    store.savePendingFlow({
      sub: `${FLOW_SUB_PREFIX}${flowId}`,
      pollToken: flow.poll.token,
      pollEndpoint: flow.poll.endpoint,
      upstreamLogin: flow.login,
      initiatorSub: user?.sub ?? null,
    });
    return { login: flow.login, flow: flowId };
  });

  api.post("/nextcloud/login-flow/poll", async (request, reply): Promise<ConnectionStatus> => {
    if (!flowPollLimit.allow(request.ip)) {
      reply.code(429);
      return { status: "disconnected" };
    }
    const user = await optionalUser(ctx, request);
    const flowId = (request.body as { flow?: unknown } | undefined)?.flow;
    if (typeof flowId !== "string" || !flowId) {
      reply.code(400);
      return { status: "disconnected" };
    }
    const pending = store.getPendingFlow(`${FLOW_SUB_PREFIX}${flowId}`);
    if (!pending) {
      if (user) {
        const cred = store.getCredential(user.sub);
        if (cred) {
          return {
            status: "connected",
            loginName: cred.loginName,
            displayName: await resolveDisplayName(ctx, cred),
            server: cred.server,
          };
        }
      }
      reply.code(409);
      return { status: "disconnected" };
    }
    if (pending.appPasswordSealed) return { status: "awaiting_claim" };
    const result = await nextcloud.pollLoginFlow(pending.pollEndpoint, pending.pollToken);
    if (!result) return { status: "pending", login: pending.upstreamLogin ?? "" };
    // Upstream login finished: park the credential on the flow and drop the
    // claim code where only the completing user can read it — their own files.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const nc = nextcloud.withCredentials(result.loginName, result.appPassword);
    try {
      await nc.davPutFile(claimFileName(code), Buffer.from(claimFileBody(code)), "text/plain");
    } catch (err) {
      store.deletePendingFlow(pending.sub);
      request.log.warn({ err }, "login-flow claim file could not be written");
      throw err;
    }
    store.completePendingFlow(pending.sub, {
      loginName: result.loginName,
      server: result.server,
      appPasswordSealed: secrets.seal(result.appPassword),
      claimHash: createHash("sha256").update(code).digest("hex"),
    });
    return { status: "awaiting_claim" };
  });

  api.post("/nextcloud/login-flow/claim", async (request, reply): Promise<ConnectionStatus> => {
    if (!flowClaimLimit.allow(request.ip)) {
      reply.code(429);
      return { status: "disconnected" };
    }
    const user = await optionalUser(ctx, request);
    const body = request.body as { flow?: unknown; code?: unknown } | undefined;
    const flowId = typeof body?.flow === "string" ? body.flow : "";
    const code = typeof body?.code === "string" ? body.code.replace(/\D/g, "") : "";
    if (!flowId || !code) {
      reply.code(400);
      return { status: "disconnected" };
    }
    const pending = store.getPendingFlow(`${FLOW_SUB_PREFIX}${flowId}`);
    if (!pending?.appPasswordSealed || !pending.claimHash || !pending.loginName) {
      reply.code(409);
      return { status: "disconnected" };
    }
    if (!codeMatches(pending.claimHash, code)) {
      const n = (claimAttempts.get(flowId) ?? 0) + 1;
      if (n >= MAX_CLAIM_ATTEMPTS) {
        store.deletePendingFlow(pending.sub);
        claimAttempts.delete(flowId);
      } else {
        claimAttempts.set(flowId, n);
      }
      reply.code(401);
      return { status: "disconnected" };
    }
    claimAttempts.delete(flowId);
    // The claimer is the proven completer: authed callers get the credential on
    // their own sub, anonymous (embedded) callers get an einring session.
    const sub = user?.sub ?? `${EMBEDDED_SUB_PREFIX}${pending.loginName}`;
    const old = store.getCredential(sub);
    const cred: NextcloudCredential = {
      sub,
      server: pending.server ?? "",
      loginName: pending.loginName,
      appPasswordSealed: pending.appPasswordSealed,
    };
    store.saveCredential(cred);
    store.deletePendingFlow(pending.sub);
    if (old) void revokeCredential(ctx, old, request.log);
    // Remove the code file from the user's cloud — best effort.
    const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
    void nc.davDelete(claimFileName(code)).catch(() => {});
    let sessionToken: string | undefined;
    if (!user) {
      // Proof of a Nextcloud login doubles as sign-in for embedded deployments.
      sessionToken = randomBytes(32).toString("base64url");
      store.saveSession(
        hashToken(sessionToken),
        sub,
        new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      );
    }
    return {
      status: "connected",
      loginName: cred.loginName,
      displayName: await resolveDisplayName(ctx, store.getCredential(sub) ?? cred),
      server: cred.server,
      sessionToken,
    };
  });
}

/** Protected scope — registered under requireAuth. */
export function registerNextcloudRoutes(api: FastifyInstance, ctx: AppContext) {
  const { store } = ctx;

  api.get("/nextcloud/connection", async (request): Promise<ConnectionStatus> => {
    const cred = store.getCredential(request.user.sub);
    if (!cred) return { status: "disconnected" };
    return {
      status: "connected",
      loginName: cred.loginName,
      displayName: await resolveDisplayName(ctx, cred),
      server: cred.server,
    };
  });

  api.delete("/nextcloud/connection", async (request, reply) => {
    const cred = store.getCredential(request.user.sub);
    if (cred) await revokeCredential(ctx, cred, request.log);
    store.deleteCredential(request.user.sub);
    store.deletePendingFlowsForInitiator(request.user.sub);
    store.deleteSessionsForSub(request.user.sub);
    return reply.code(204).send();
  });
}
