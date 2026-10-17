import { z } from "zod";
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
  /** Default instance URL for the deployment; the connect form may override it. */
  URL: z.url().optional(),
});
type AudiobookshelfConfig = z.infer<typeof configSchema>;

interface AbsLibrary {
  id: string;
  name?: string;
}
interface AbsProgress {
  libraryItemId: string;
  progress?: number;
  isFinished?: boolean;
  currentTime?: number;
  duration?: number;
}
interface AbsItem {
  id: string;
  media?: { metadata?: { title?: string; authorName?: string } };
}

function slimProgress(p: AbsProgress, title?: string | null) {
  return {
    itemId: p.libraryItemId,
    title: title ?? null,
    progressPct: Math.round((p.progress ?? 0) * 100),
    finished: p.isFinished === true,
  };
}

async function absGet<T>(fetchImpl: Fetch, url: string, token: string, path: string) {
  return connectorGet<T>(fetchImpl, url, `/api${path}`, { Authorization: `Bearer ${token}` });
}

const options = (config: AudiobookshelfConfig): ConnectorOptions => ({
  service: "audiobookshelf",
  defaultUrl: config.URL,
  parseSecret: apiKeySecret,
  verify: async (fetchImpl, url, token) => (await absGet(fetchImpl, url, token, "/me")).status,
});

export const audiobookshelfModule: BffModule<AudiobookshelfConfig> = {
  id: "audiobookshelf",
  configSchema,

  chatTools(ctx): ChatTool[] {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const credFor = (sub: string) => connectorCred(ctx, sub, "audiobookshelf");
    return [
      {
        name: "audiobookshelf_search",
        description:
          "Search the user's Audiobookshelf libraries for audiobooks/podcasts by title or author. Returns matches with listening progress (0-100%, finished flag). Use for 'have I listened to X?' questions.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Title or author to search" } },
          required: ["query"],
        },
        async call(args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const q = typeof args.query === "string" ? args.query.trim() : "";
          if (!q) return { error: "empty query" };
          const libs = await absGet<{ libraries?: AbsLibrary[] }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "/libraries",
          );
          const me = await absGet<{ mediaProgress?: AbsProgress[] }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "/me",
          );
          const progress = new Map((me.body?.mediaProgress ?? []).map((p) => [p.libraryItemId, p]));
          const matches: unknown[] = [];
          for (const lib of libs.body?.libraries ?? []) {
            const res = await absGet<{ book?: { libraryItem: AbsItem }[] }>(
              fetchImpl,
              cred.url,
              cred.secret,
              `/libraries/${lib.id}/search?q=${encodeURIComponent(q)}`,
            );
            for (const hit of res.body?.book ?? []) {
              const item = hit.libraryItem;
              const p = progress.get(item.id);
              matches.push({
                title: item.media?.metadata?.title ?? null,
                author: item.media?.metadata?.authorName ?? null,
                library: lib.name ?? null,
                progressPct: Math.round((p?.progress ?? 0) * 100),
                finished: p?.isFinished === true,
              });
            }
            if (matches.length >= 20) break;
          }
          return { matches: matches.slice(0, 20) };
        },
      },
      {
        name: "audiobookshelf_in_progress",
        description:
          "List the audiobooks/podcasts the user is currently listening to (started but not finished), with progress percent.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const me = await absGet<{ mediaProgress?: AbsProgress[] }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "/me",
          );
          if (!me.body) return { error: `audiobookshelf returned ${me.status}` };
          const open = (me.body.mediaProgress ?? [])
            .filter((p) => !p.isFinished && (p.progress ?? 0) > 0)
            .slice(0, 10);
          const items = await Promise.all(
            open.map(async (p) => {
              const item = await absGet<AbsItem>(
                fetchImpl,
                cred.url,
                cred.secret,
                `/items/${p.libraryItemId}`,
              );
              return slimProgress(p, item.body?.media?.metadata?.title);
            }),
          );
          return { in_progress: items };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, options(config));
  },
};
