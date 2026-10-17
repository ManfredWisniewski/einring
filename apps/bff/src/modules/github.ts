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
  /** Default instance web URL (github.com or a GHES host); the form may override it. */
  URL: z.url().optional(),
});
type GitHubConfig = z.infer<typeof configSchema>;

export interface GitHubNotification {
  /** Thread id — also the einhub dedupe key. */
  id: string;
  unread: boolean;
  /** Why the user is notified: mention, review_requested, assigned, ci_activity, … */
  reason: string;
  title: string;
  /** Issue, PullRequest, Commit, Release, Discussion, CheckSuite, … */
  type: string;
  repo: string | null;
  /** Web link to the subject (derived from the API URL). */
  url: string | null;
  updatedAt: string;
}

interface GitHubThreadRaw {
  id: string;
  unread: boolean;
  reason?: string;
  updated_at?: string;
  subject?: { title?: string; url?: string; type?: string };
  repository?: { full_name?: string };
}

/**
 * Instance web URL → REST base: api.github.com for github.com,
 * <host>/api/v3 for GHES.
 */
export function apiBase(webUrl: string): string {
  const u = new URL(webUrl);
  if (u.hostname === "github.com" || u.hostname === "www.github.com")
    return "https://api.github.com";
  return `${u.origin}/api/v3`;
}

/** API subject URL → web URL (https://api.github.com/repos/o/r/issues/1 → github.com/o/r/issues/1). */
function htmlUrl(webUrl: string, subjectUrl: string | undefined): string | null {
  if (!subjectUrl) return null;
  return subjectUrl.replace(`${apiBase(webUrl)}/repos/`, `${webUrl}/`);
}

function mapThread(webUrl: string, t: GitHubThreadRaw): GitHubNotification {
  return {
    id: t.id,
    unread: t.unread === true,
    reason: t.reason ?? "unknown",
    title: t.subject?.title ?? "",
    type: t.subject?.type ?? "unknown",
    repo: t.repository?.full_name ?? null,
    url: htmlUrl(webUrl, t.subject?.url),
    updatedAt: t.updated_at ?? "",
  };
}

function credFor(ctx: AppContext, sub: string) {
  return connectorCred(ctx, sub, "github");
}

async function githubGet<T>(
  ctx: AppContext,
  apiBaseUrl: string,
  token: string,
  path: string,
): Promise<{ status: number; body: T | null }> {
  return connectorGet<T>(ctx.fetchImpl ?? fetch, apiBaseUrl, path, {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

async function listThreads(ctx: AppContext, sub: string, limit: number) {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true as const };
  const base = apiBase(cred.url);
  const res = await githubGet<GitHubThreadRaw[]>(
    ctx,
    base,
    cred.secret,
    `/notifications?per_page=${limit}`,
  );
  if (res.status === 401 || res.status === 403) return { rejected: true as const };
  if (!res.body) return { failed: res.status };
  return { threads: (res.body ?? []).map((t) => mapThread(cred.url, t)) };
}

export const githubModule: BffModule<GitHubConfig> = {
  id: "github",
  configSchema,

  notifications(ctx) {
    return {
      // Notification threads → einhub items; dedupe by thread id (D42/D44).
      async poll(sub) {
        const res = await listThreads(ctx, sub, 10);
        if (!("threads" in res) || !res.threads) return [];
        return res.threads.map((t) => ({
          sourceId: t.id,
          title: `${t.reason}: ${t.title}`,
          body: [t.repo, t.type].filter(Boolean).join(" · ") || undefined,
          at: t.updatedAt || undefined,
        }));
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "github_notifications",
        description:
          "List the user's GitHub notification threads — mentions, review requests, assignments, CI results (repo, reason, title, link).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max threads to return (default 10, max 50)" },
          },
        },
        async call(args, sub) {
          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
          const res = await listThreads(ctx, sub, limit);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("rejected" in res) return { error: "github rejected the token" };
          if ("failed" in res) return { error: `github returned ${res.failed}` };
          return { notifications: res.threads };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "github",
      defaultUrl: config.URL,
      parseSecret: apiKeySecret,
      verify: async (fetchImpl, url, token) => {
        const res = await fetchImpl(`${apiBase(url)}/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        });
        return res.status;
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/notifications", async (req, reply) => {
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string }).limit) || 20, 1),
        50,
      );
      const res = await listThreads(ctx, req.user.sub, limit);
      if ("notConnected" in res) return reply.code(424).send({ error: "not connected" });
      if ("rejected" in res) return reply.code(401).send({ error: "github rejected the token" });
      if ("failed" in res)
        return reply.code(502).send({ error: `github unreachable (${res.failed})` });
      return { notifications: res.threads };
    });
  },
};
