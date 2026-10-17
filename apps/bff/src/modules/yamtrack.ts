import { z } from "zod";
import type { Fetch } from "../nextcloud/client.js";
import {
  apiKeySecret,
  type ConnectorOptions,
  connectorCred,
  normalizeBase,
  registerConnectorRoutes,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

/** Yamtrack media types (API route segment + enum). */
const MEDIA_TYPES = [
  "movie",
  "tv",
  "season",
  "episode",
  "book",
  "comic",
  "anime",
  "manga",
  "game",
] as const;
const mediaTypeSchema = z.enum(MEDIA_TYPES);

/** Status codes in the tracked-list response (Yamtrack API v1). */
const STATUS_LABEL: Record<number, string> = {
  0: "planning",
  1: "watching",
  2: "paused",
  3: "completed",
  4: "dropped",
};

interface TrackedMedia {
  title?: string;
  media_id?: string | number;
  media_type?: string;
  source?: string;
  status?: number;
  score?: number | null;
  progress?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

const configSchema = z.object({
  /** Default instance URL for the deployment; the connect form may override it. */
  URL: z.url().optional(),
});

type YamtrackConfig = z.infer<typeof configSchema>;

async function yamtrackGet<T>(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
): Promise<{ status: number; body: T | null }> {
  const res = await fetchImpl(`${normalizeBase(baseUrl)}/api/v1${path}`, {
    headers: { Accept: "application/json", "X-API-Key": apiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

/** Slimmed-down tracked item for tool results — keeps prompts small. */
function slim(m: TrackedMedia) {
  return {
    title: m.title ?? null,
    media_id: m.media_id ?? null,
    media_type: m.media_type ?? null,
    source: m.source ?? null,
    status: typeof m.status === "number" ? (STATUS_LABEL[m.status] ?? m.status) : null,
    watched: m.status === 3 || (m.end_date != null && m.end_date !== ""),
    end_date: m.end_date ?? null,
    score: m.score ?? null,
  };
}

/** Lists the user's tracked media of one type (up to `limit`). */
async function listTracked(
  fetchImpl: Fetch,
  baseUrl: string,
  apiKey: string,
  mediaType: string,
  limit: number,
): Promise<TrackedMedia[] | { status: number }> {
  const { status, body } = await yamtrackGet<unknown>(
    fetchImpl,
    baseUrl,
    apiKey,
    `/media/${mediaType}/?limit=${limit}&offset=0`,
  );
  if (!body) return { status };
  const items = Array.isArray(body)
    ? body
    : Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : [];
  return items as TrackedMedia[];
}

const options = (config: YamtrackConfig): ConnectorOptions => ({
  service: "yamtrack",
  defaultUrl: config.URL,
  parseSecret: apiKeySecret,
  verify: async (fetchImpl, url, apiKey) =>
    (await yamtrackGet(fetchImpl, url, apiKey, "/media/movie/?limit=1")).status,
});

export const yamtrackModule: BffModule<YamtrackConfig> = {
  id: "yamtrack",
  configSchema,

  chatTools(ctx): ChatTool[] {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const credFor = (sub: string) => {
      const c = connectorCred(ctx, sub, "yamtrack");
      return c ? { url: c.url, apiKey: c.secret } : null;
    };
    const tracked = async (sub: string, mediaType: string) => {
      const cred = credFor(sub);
      if (!cred) return { error: "not_connected" } as const;
      const listed = await listTracked(fetchImpl, cred.url, cred.apiKey, mediaType, 200);
      if (!Array.isArray(listed)) {
        return { error: `yamtrack returned ${listed.status}` } as const;
      }
      return listed;
    };

    return [
      {
        name: "yamtrack_search_media",
        description:
          "Search the user's tracked media in their Yamtrack library (movies, TV, books, games). Returns matching items with watched/completed status. Use this to answer questions like 'have I watched X?'.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Title or part of the title to search for" },
            media_type: {
              type: "string",
              enum: MEDIA_TYPES,
              description: "Media type to search; omit to search all types",
            },
          },
          required: ["query"],
        },
        async call(args, sub) {
          const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
          if (!query) return { error: "empty query" };
          const types = mediaTypeSchema.safeParse(args.media_type).success
            ? [args.media_type as (typeof MEDIA_TYPES)[number]]
            : [...MEDIA_TYPES];
          const out: unknown[] = [];
          for (const type of types) {
            const items = await tracked(sub, type);
            if (!Array.isArray(items)) {
              if ((items as { error: string }).error === "not_connected") return items;
              continue; // a type that 404s (e.g. disabled feature) is skipped
            }
            for (const item of items) {
              if ((item.title ?? "").toLowerCase().includes(query)) out.push(slim(item));
            }
            if (out.length >= 20) break;
          }
          return { matches: out.slice(0, 20) };
        },
      },
      {
        name: "yamtrack_list_media",
        description:
          "List the user's tracked media of one type in Yamtrack (max 50, most recent first not guaranteed). Good for 'what am I watching?' questions.",
        parameters: {
          type: "object",
          properties: {
            media_type: { type: "string", enum: MEDIA_TYPES, description: "Media type to list" },
          },
          required: ["media_type"],
        },
        async call(args, sub) {
          const parsed = mediaTypeSchema.safeParse(args.media_type);
          if (!parsed.success)
            return { error: `media_type must be one of ${MEDIA_TYPES.join(", ")}` };
          const items = await tracked(sub, parsed.data);
          if (!Array.isArray(items)) return items;
          return { items: items.slice(0, 50).map(slim) };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, options(config));
  },
};
