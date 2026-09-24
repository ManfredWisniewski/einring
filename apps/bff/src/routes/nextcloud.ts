import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | { status: "connected"; loginName: string; server: string };

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

  api.get("/nextcloud/connection", async (request): Promise<ConnectionStatus> => {
    const cred = store.getCredential(request.user.sub);
    if (cred) return { status: "connected", loginName: cred.loginName, server: cred.server };
    return { status: "disconnected" };
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
      if (cred) return { status: "connected", loginName: cred.loginName, server: cred.server };
      reply.code(409);
      return { status: "disconnected" };
    }
    const result = await nextcloud.pollLoginFlow(pending.pollEndpoint, pending.pollToken);
    if (!result) return { status: "pending", login: "" };
    store.saveCredential({
      sub,
      server: result.server,
      loginName: result.loginName,
      appPasswordSealed: secrets.seal(result.appPassword),
    });
    store.deletePendingFlow(sub);
    return { status: "connected", loginName: result.loginName, server: result.server };
  });

  api.delete("/nextcloud/connection", async (request, reply) => {
    store.deleteCredential(request.user.sub);
    store.deletePendingFlow(request.user.sub);
    return reply.code(204).send();
  });
}
