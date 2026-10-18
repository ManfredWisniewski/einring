import type { AppContext } from "../app.js";
import type { AuthenticatedNextcloud } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

/** Authenticated client for the caller, or null when Nextcloud is disconnected. */
function ncFor(ctx: AppContext, sub: string): AuthenticatedNextcloud | null {
  const cred = ctx.store.getCredential(sub);
  return cred
    ? ctx.nextcloud.withCredentials(cred.loginName, ctx.secrets.open(cred.appPasswordSealed))
    : null;
}

/**
 * Passman vault viewer (D50). The BFF only proxies the Passman app's REST API —
 * credential fields stay SJCL-encrypted end-to-end; the vault key and all
 * plaintexts live exclusively in the webview. Read-only by design, no chatTools.
 */
export const passmanModule: BffModule = {
  id: "passman",
  requires: ["nextcloud"],
  register(api, ctx) {
    api.get("/vaults", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const vaults = await nc.getPassman("/vaults");
      return { vaults };
    });

    api.get("/vaults/:guid", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const guid = (req.params as { guid: string }).guid;
      const vault = await nc.getPassman(`/vaults/${encodeURIComponent(guid)}`);
      return { vault };
    });
  },
};
