import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import type { NextcloudCredential } from "../db.js";

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | { status: "connected"; loginName: string; displayName: string | null; server: string };

/**
 * Nextcloud Login Flow v2, held server-side so the app password never reaches the client.
 *
 *   POST /api/nextcloud/login-flow        -> { login }  (URL to open in the system browser)
 *   POST /api/nextcloud/login-flow/poll   -> { status: "pending" } | { status: "connected", ... }
 *   GET  /api/nextcloud/connection        -> ConnectionStatus
 *   DELETE /api/nextcloud/connection
 */
export function registerNextcloudRoutes(api: FastifyInstance, ctx: AppContext) {
  const { store, secrets, nextcloud } = ctx;

  /** Fetches the account's display name once and stores it on the credential. */
  async function resolveDisplayName(cred: NextcloudCredential): Promise<string | null> {
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

  api.get("/nextcloud/connection", async (request): Promise<ConnectionStatus> => {
    const cred = store.getCredential(request.user.sub);
    if (!cred) return { status: "disconnected" };
    return {
      status: "connected",
      loginName: cred.loginName,
      displayName: await resolveDisplayName(cred),
      server: cred.server,
    };
  });

  api.post("/nextcloud/login-flow", async (request) => {
    const flow = await nextcloud.startLoginFlow();
    store.savePendingFlow({
      sub: request.user.sub,
      pollToken: flow.poll.token,
      pollEndpoint: flow.poll.endpoint,
    });
    return { login: flow.login };
  });

  api.post("/nextcloud/login-flow/poll", async (request, reply): Promise<ConnectionStatus> => {
    const { sub } = request.user;
    const pending = store.getPendingFlow(sub);
    if (!pending) {
      const cred = store.getCredential(sub);
      if (cred) {
        return {
          status: "connected",
          loginName: cred.loginName,
          displayName: await resolveDisplayName(cred),
          server: cred.server,
        };
      }
      reply.code(409);
      return { status: "disconnected" };
    }
    const result = await nextcloud.pollLoginFlow(pending.pollEndpoint, pending.pollToken);
    if (!result) return { status: "pending", login: "" };
    const cred = {
      sub,
      server: result.server,
      loginName: result.loginName,
      appPasswordSealed: secrets.seal(result.appPassword),
    };
    store.saveCredential(cred);
    store.deletePendingFlow(sub);
    return {
      status: "connected",
      loginName: cred.loginName,
      displayName: await resolveDisplayName(store.getCredential(sub) ?? cred),
      server: cred.server,
    };
  });

  api.delete("/nextcloud/connection", async (request, reply) => {
    store.deleteCredential(request.user.sub);
    store.deletePendingFlow(request.user.sub);
    return reply.code(204).send();
  });
}
