import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Fetch } from "../nextcloud/client.js";
import {
  apiKeySecret,
  type ConnectorOptions,
  connectorCred,
  connectorGet,
  registerConnectorRoutes,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default Authentik instance URL; the connect form may override it. */
  URL: z.url().optional(),
});
type AuthentikConfig = z.infer<typeof configSchema>;

export interface AuthentikEvent {
  action: string;
  created: string;
  app: string | null;
  user: string | null;
}

/**
 * Aggregated Authentik health snapshot (D45). Every field is independently
 * nullable — endpoint access depends on the token's permissions, so a partial
 * answer is expected rather than an error.
 */
export interface AuthentikStatus {
  /** The account the stored token belongs to. */
  account: { username: string; name: string | null } | null;
  version: { current: string | null; latest: string | null; outdated: boolean | null } | null;
  counts: {
    users: number | null;
    groups: number | null;
    applications: number | null;
    outposts: number | null;
  };
  /** Connected worker count, null when the endpoint is absent or denied. */
  workers: number | null;
  tasks: { total: number; failed: number; failedNames: string[] } | null;
  events: { loginFailedTotal: number | null; recent: AuthentikEvent[] } | null;
  fetchedAt: string;
}

interface Paginated {
  pagination?: { count?: number };
}

interface TaskRaw {
  full_name?: string;
  name?: string;
  status?: string;
}

interface EventRaw {
  action?: string;
  created?: string;
  app?: string;
  user?: { username?: string; name?: string };
}

async function akGet<T>(
  fetchImpl: Fetch,
  base: string,
  token: string,
  path: string,
): Promise<T | null> {
  const res = await connectorGet<T>(fetchImpl, base, path, {
    Authorization: `Bearer ${token}`,
  });
  return res.body;
}

const API = "/api/v3";

async function gatherStatus(ctx: AppContext, sub: string): Promise<AuthentikStatus | null> {
  const cred = connectorCred(ctx, sub, "authentik");
  if (!cred) return null;
  const f = ctx.fetchImpl ?? fetch;
  const base = `${cred.url}${API}`;

  const [me, version, users, groups, apps, outposts, tasks, workers, failedLogins, events] =
    await Promise.all([
      akGet<{ username?: string; name?: string }>(f, base, cred.secret, "/core/users/me/"),
      akGet<{ version_current?: string; version_latest?: string; outdated?: boolean }>(
        f,
        base,
        cred.secret,
        "/admin/version/",
      ),
      akGet<Paginated>(f, base, cred.secret, "/core/users/?page_size=1"),
      akGet<Paginated>(f, base, cred.secret, "/core/groups/?page_size=1"),
      akGet<Paginated>(f, base, cred.secret, "/core/applications/?page_size=1"),
      akGet<Paginated>(f, base, cred.secret, "/outposts/instances/?page_size=1"),
      akGet<TaskRaw[] | Paginated>(f, base, cred.secret, "/admin/system_tasks/?page_size=200"),
      // /admin/workers/ shape varies by version: array, {count} or {workers: n}.
      akGet<unknown>(f, base, cred.secret, "/admin/workers/"),
      akGet<Paginated>(f, base, cred.secret, "/events/events/?action=login_failed&page_size=1"),
      akGet<{ results?: EventRaw[] }>(
        f,
        base,
        cred.secret,
        "/events/events/?ordering=-created&page_size=10",
      ),
    ]);

  if (
    !me &&
    !version &&
    !users &&
    !groups &&
    !apps &&
    !outposts &&
    !tasks &&
    !workers &&
    !failedLogins &&
    !events
  ) {
    throw new Error("authentik unreachable");
  }

  // /admin/system_tasks/ is a plain array in older versions, paginated in newer.
  const taskResults = Array.isArray(tasks)
    ? tasks
    : ((tasks as { results?: TaskRaw[] } | null)?.results ?? []);
  const failed = taskResults.filter((t) => t.status === "error" || t.status === "warning");

  let workersCount: number | null = null;
  if (Array.isArray(workers)) workersCount = workers.length;
  else if (workers && typeof workers === "object") {
    const w = workers as { workers?: number; count?: number; results?: unknown[] };
    workersCount = w.workers ?? w.count ?? (Array.isArray(w.results) ? w.results.length : null);
  }

  return {
    account: me ? { username: me.username ?? "", name: me.name ?? null } : null,
    version: version
      ? {
          current: version.version_current ?? null,
          latest: version.version_latest ?? null,
          outdated: version.outdated ?? null,
        }
      : null,
    counts: {
      users: users?.pagination?.count ?? null,
      groups: groups?.pagination?.count ?? null,
      applications: apps?.pagination?.count ?? null,
      outposts: outposts?.pagination?.count ?? null,
    },
    workers: workersCount,
    tasks: tasks
      ? {
          total: taskResults.length,
          failed: failed.length,
          failedNames: failed.slice(0, 10).map((t) => t.full_name ?? t.name ?? "?"),
        }
      : null,
    events:
      events || failedLogins
        ? {
            loginFailedTotal: failedLogins?.pagination?.count ?? null,
            recent: (events?.results ?? []).map((e) => ({
              action: e.action ?? "unknown",
              created: e.created ?? "",
              app: e.app ?? null,
              user: e.user?.username ?? e.user?.name ?? null,
            })),
          }
        : null,
    fetchedAt: new Date().toISOString(),
  };
}

export const authentikModule: BffModule<AuthentikConfig> = {
  id: "authentik",
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "authentik_status",
        description:
          "Get the Authentik instance health snapshot — version/outdated, user/group/app/outpost counts, workers, failed system tasks, recent events.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const status = await gatherStatus(ctx, sub).catch(() => null);
          if (!status)
            return {
              error: connectorCred(ctx, sub, "authentik") ? "unreachable" : "not_connected",
            };
          return status;
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "authentik",
      defaultUrl: config.URL,
      parseSecret: apiKeySecret,
      verify: async (fetchImpl, url, token) => {
        const res = await fetchImpl(`${url}${API}/core/users/me/`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        return res.status;
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/health", async (req, reply) => {
      const cred = connectorCred(ctx, req.user.sub, "authentik");
      if (!cred) return reply.code(424).send({ error: "not connected" });
      const status = await gatherStatus(ctx, req.user.sub).catch((e: unknown) => {
        api.log.warn(e, "authentik status failed");
        return null;
      });
      if (!status) return reply.code(502).send({ error: "authentik unreachable" });
      return status;
    });
  },
};
