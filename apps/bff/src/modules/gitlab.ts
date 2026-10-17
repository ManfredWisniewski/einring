import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  apiKeySecret,
  type ConnectorOptions,
  connectorCred,
  connectorGet,
  registerConnectorRoutes,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default instance URL for the deployment (e.g. the company GitLab); the form may override it. */
  URL: z.url().optional(),
});
type GitLabConfig = z.infer<typeof configSchema>;

export interface GitLabTodo {
  id: number;
  project: string | null;
  author: string | null;
  /** action_name verbatim: assigned, mentioned, approval_required, build_failed, … */
  action: string;
  /** MergeRequest, Issue, Commit, Epic, DesignManagement::Design, … */
  targetType: string;
  title: string;
  /** Full upstream URL to the target — the "open" link. */
  url: string | null;
  createdAt: string;
}

interface GitLabTodoRaw {
  id: number;
  project?: { name?: string; name_with_namespace?: string } | null;
  author?: { name?: string; username?: string } | null;
  action_name?: string;
  target_type?: string;
  target?: { title?: string } | null;
  target_url?: string;
  created_at?: string;
}

function mapTodo(t: GitLabTodoRaw): GitLabTodo {
  return {
    id: t.id,
    project: t.project?.name_with_namespace ?? t.project?.name ?? null,
    author: t.author?.name ?? t.author?.username ?? null,
    action: t.action_name ?? "unknown",
    targetType: t.target_type ?? "unknown",
    title: t.target?.title ?? "",
    url: t.target_url ?? null,
    createdAt: t.created_at ?? "",
  };
}

function credFor(ctx: AppContext, sub: string) {
  return connectorCred(ctx, sub, "gitlab");
}

async function gitlabGet<T>(
  ctx: AppContext,
  url: string,
  token: string,
  path: string,
): Promise<{ status: number; body: T | null }> {
  return connectorGet<T>(ctx.fetchImpl ?? fetch, url, `/api/v4${path}`, {
    "PRIVATE-TOKEN": token,
  });
}

async function listTodos(ctx: AppContext, sub: string, limit: number) {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true as const };
  const res = await gitlabGet<GitLabTodoRaw[]>(
    ctx,
    cred.url,
    cred.secret,
    `/todos?state=pending&per_page=${limit}`,
  );
  if (res.status === 401 || res.status === 403) return { rejected: true as const };
  if (!res.body) return { failed: res.status };
  return { todos: (res.body ?? []).map(mapTodo) };
}

export const gitlabModule: BffModule<GitLabConfig> = {
  id: "gitlab",
  configSchema,

  notifications(ctx) {
    return {
      // Pending todos → einhub items; dedupe by todo id (D42/D43).
      async poll(sub) {
        const res = await listTodos(ctx, sub, 10);
        if (!("todos" in res) || !res.todos) return [];
        return res.todos.map((t) => ({
          sourceId: String(t.id),
          title: `${t.action}: ${t.title}`,
          body: [t.project, t.author].filter(Boolean).join(" · ") || undefined,
          at: t.createdAt || undefined,
        }));
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "gitlab_todos",
        description:
          "List the user's pending GitLab todos — assignments, mentions, review requests, failed pipelines (project, author, action, title, link).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max todos to return (default 10, max 50)" },
          },
        },
        async call(args, sub) {
          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
          const res = await listTodos(ctx, sub, limit);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("rejected" in res) return { error: "gitlab rejected the token" };
          if ("failed" in res) return { error: `gitlab returned ${res.failed}` };
          return { todos: res.todos };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "gitlab",
      defaultUrl: config.URL,
      parseSecret: apiKeySecret,
      verify: async (fetchImpl, url, token) => {
        const res = await fetchImpl(`${url.replace(/\/+$/, "")}/api/v4/user`, {
          headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        return res.status;
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/todos", async (req, reply) => {
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string }).limit) || 20, 1),
        100,
      );
      const res = await listTodos(ctx, req.user.sub, limit);
      if ("notConnected" in res) return reply.code(424).send({ error: "not connected" });
      if ("rejected" in res) return reply.code(401).send({ error: "gitlab rejected the token" });
      if ("failed" in res)
        return reply.code(502).send({ error: `gitlab unreachable (${res.failed})` });
      return { todos: res.todos };
    });
  },
};
