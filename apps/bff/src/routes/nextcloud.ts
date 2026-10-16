import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app.js";
import { type AuthUser, hashToken } from "../auth.js";
import type { NextcloudCredential } from "../db.js";

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | {
      status: "connected";
      loginName: string;
      displayName: string | null;
      server: string;
      /** Present only when an anonymous (embedded) flow completes: the einring session token. */
      sessionToken?: string;
    };

/** Pending flows for unauthenticated callers are keyed `flow:<id>` so no real `sub` is touched. */
const FLOW_SUB_PREFIX = "flow:";
/** Credential identity for sessions minted in embedded mode. */
const EMBEDDED_SUB_PREFIX = "nc:";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Nextcloud Login Flow v2, held server-side so the app password never reaches the client.
 *
 *   GET    /api/nextcloud/connection       -> ConnectionStatus                    (auth)
 *   DELETE /api/nextcloud/connection       -> 204, drops credential + sessions    (auth)
 *   POST   /api/nextcloud/login-flow       -> { login, flow? }                    (auth optional)
 *   POST   /api/nextcloud/login-flow/poll  -> pending | connected(+sessionToken?) (auth optional)
 *
 * The two login-flow routes also work without a bearer token (embedded deployments skip
 * Authentik): the flow is then keyed by a random `flow` id the client must echo on poll;
 * completing it mints an einring session token for `nc:<loginName>`.
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

/** Public scope — registered WITHOUT requireAuth; anonymous callers use a `flow` id. */
export function registerNextcloudPublicRoutes(api: FastifyInstance, ctx: AppContext) {
  const { store, secrets, nextcloud } = ctx;

  api.post("/nextcloud/login-flow", async (request) => {
    const flow = await nextcloud.startLoginFlow();
    const user = await optionalUser(ctx, request);
    if (user) {
      store.savePendingFlow({
        sub: user.sub,
        pollToken: flow.poll.token,
        pollEndpoint: flow.poll.endpoint,
      });
      return { login: flow.login };
    }
    const flowId = randomBytes(16).toString("base64url");
    store.savePendingFlow({
      sub: `${FLOW_SUB_PREFIX}${flowId}`,
      pollToken: flow.poll.token,
      pollEndpoint: flow.poll.endpoint,
    });
    return { login: flow.login, flow: flowId };
  });

  api.post("/nextcloud/login-flow/poll", async (request, reply): Promise<ConnectionStatus> => {
    const user = await optionalUser(ctx, request);
    const flowId = (request.body as { flow?: unknown } | undefined)?.flow;
    if (!user && typeof flowId !== "string") {
      reply.code(400);
      return { status: "disconnected" };
    }
    // Authentik/session-authed callers keep their own sub; anonymous callers address
    // the pending flow by the id issued at start. Their credential lands on nc:<login>.
    const flowSub = user?.sub ?? `${FLOW_SUB_PREFIX}${flowId}`;
    const pending = store.getPendingFlow(flowSub);
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
    const result = await nextcloud.pollLoginFlow(pending.pollEndpoint, pending.pollToken);
    if (!result) return { status: "pending", login: "" };
    const sub = user?.sub ?? `${EMBEDDED_SUB_PREFIX}${result.loginName}`;
    const cred = {
      sub,
      server: result.server,
      loginName: result.loginName,
      appPasswordSealed: secrets.seal(result.appPassword),
    };
    store.saveCredential(cred);
    store.deletePendingFlow(flowSub);
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
    store.deleteCredential(request.user.sub);
    store.deletePendingFlow(request.user.sub);
    store.deleteSessionsForSub(request.user.sub);
    return reply.code(204).send();
  });
}
