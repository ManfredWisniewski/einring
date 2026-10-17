import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Fetch } from "../nextcloud/client.js";
import {
  type ConnectorOptions,
  connectorCred,
  normalizeBase,
  registerConnectorRoutes,
  userPassSecret,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default instance URL for the deployment; the connect form may override it. */
  URL: z.url().optional(),
});
type NavidromeConfig = z.infer<typeof configSchema>;

interface SubsonicResponse<T> {
  "subsonic-response": { status: "ok" | "failed"; error?: { code: number; message: string } } & T;
}

interface NavidromeSecret {
  username: string;
  password: string;
}

function parseSecret(secret: string): NavidromeSecret | null {
  try {
    const s: unknown = JSON.parse(secret);
    const r = s as NavidromeSecret;
    return r.username && r.password ? r : null;
  } catch {
    return null;
  }
}

/** Subsonic auth query params: t = md5(password + salt), s = salt. */
function authParams(secret: NavidromeSecret): string {
  const salt = randomBytes(6).toString("hex");
  const token = createHash("md5")
    .update(secret.password + salt)
    .digest("hex");
  const p = new URLSearchParams({
    u: secret.username,
    t: token,
    s: salt,
    v: "1.16.1",
    c: "einring",
    f: "json",
  });
  return p.toString();
}

async function subsonic<T>(
  fetchImpl: Fetch,
  url: string,
  secret: NavidromeSecret,
  endpoint: string,
  extra = "",
): Promise<{ status: number; data: T | null }> {
  const res = await fetchImpl(
    `${normalizeBase(url)}/rest/${endpoint}?${authParams(secret)}${extra}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return { status: res.status, data: null };
  const body = (await res.json()) as SubsonicResponse<T>;
  if (body["subsonic-response"]?.status !== "ok") {
    // Subsonic wraps errors in the body — code 40 = wrong credentials.
    return { status: body["subsonic-response"].error?.code === 40 ? 401 : 502, data: null };
  }
  return { status: 200, data: body["subsonic-response"] as T };
}

const options = (config: NavidromeConfig): ConnectorOptions => ({
  service: "navidrome",
  defaultUrl: config.URL,
  parseSecret: userPassSecret,
  verify: async (fetchImpl, url, secretJson) => {
    const secret = parseSecret(secretJson);
    if (!secret) return 400;
    return (await subsonic(fetchImpl, url, secret, "ping.view")).status;
  },
});

export const navidromeModule: BffModule<NavidromeConfig> = {
  id: "navidrome",
  configSchema,

  chatTools(ctx): ChatTool[] {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const credFor = (sub: string) => {
      const c = connectorCred(ctx, sub, "navidrome");
      const secret = c ? parseSecret(c.secret) : null;
      return c && secret ? { url: c.url, secret } : null;
    };
    return [
      {
        name: "navidrome_search",
        description:
          "Search the user's Navidrome music library for artists, albums and songs. Use for 'do I have X?' or 'music by X' questions.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Artist, album or song to search" } },
          required: ["query"],
        },
        async call(args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const q = typeof args.query === "string" ? args.query.trim() : "";
          if (!q) return { error: "empty query" };
          const res = await subsonic<{
            searchResult3?: {
              artist?: { name?: string }[];
              album?: { name?: string; artist?: string; year?: number }[];
              song?: { title?: string; artist?: string; album?: string }[];
            };
          }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "search3.view",
            `&query=${encodeURIComponent(q)}&artistCount=5&albumCount=10&songCount=10`,
          );
          if (!res.data) return { error: `navidrome returned ${res.status}` };
          const r = res.data.searchResult3 ?? {};
          return {
            artists: (r.artist ?? []).map((a) => a.name).slice(0, 5),
            albums: (r.album ?? [])
              .map((a) => ({
                name: a.name ?? null,
                artist: a.artist ?? null,
                year: a.year ?? null,
              }))
              .slice(0, 10),
            songs: (r.song ?? [])
              .map((s) => ({
                title: s.title ?? null,
                artist: s.artist ?? null,
                album: s.album ?? null,
              }))
              .slice(0, 10),
          };
        },
      },
      {
        name: "navidrome_albums",
        description:
          "List albums from the user's Navidrome library — newest additions, recently played, starred, or random.",
        parameters: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["newest", "recent", "starred", "random"],
              description: "Which list to return (default newest)",
            },
          },
        },
        async call(args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const type = z
            .enum(["newest", "recent", "starred", "random"])
            .catch("newest")
            .parse(args.type);
          const res = await subsonic<{
            albumList?: { album?: { name?: string; artist?: string; year?: number }[] };
          }>(fetchImpl, cred.url, cred.secret, "getAlbumList.view", `&type=${type}&size=30`);
          if (!res.data) return { error: `navidrome returned ${res.status}` };
          return {
            type,
            albums: (res.data.albumList?.album ?? [])
              .map((a) => ({
                name: a.name ?? null,
                artist: a.artist ?? null,
                year: a.year ?? null,
              }))
              .slice(0, 30),
          };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, options(config));
  },
};
