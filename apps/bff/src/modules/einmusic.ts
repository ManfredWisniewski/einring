import { createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { connectorCred, normalizeBase } from "./connectors.js";
import { authParams, parseSecret, subsonic } from "./navidrome.js";
import type { BffModule, ChatTool } from "./types.js";

/** Audio files live under DATA_DIR/einmusic/ next to einring.sqlite (D48). */
function mediaDir(ctx: AppContext): string {
  const dir = resolve(ctx.config.DATA_DIR, "einmusic");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const trackFile = (ctx: AppContext, id: number) => resolve(mediaDir(ctx), `${id}.mp3`);

/** "Artist - Title.mp3" → {artist, title}; falls back to the bare filename as title. */
export function parseTrackName(fileName: string): { title: string; artist: string | null } {
  const base = (fileName.replaceAll("\\", "/").split("/").at(-1) ?? "")
    .replace(/\.mp3$/i, "")
    .trim()
    .slice(0, 200);
  const parts = base.split(" - ");
  return parts.length > 1
    ? { title: parts.slice(1).join(" - "), artist: parts[0] || null }
    : { title: base || "track", artist: null };
}

const putPlaylistSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  trackIds: z.array(z.number().int()).optional(),
});

interface SubsonicPlaylist {
  id?: string;
  name?: string;
  songCount?: number;
  duration?: number;
  entry?: { id?: string; title?: string; artist?: string; album?: string; duration?: number }[];
}

function navidromeCred(ctx: AppContext, sub: string) {
  const c = connectorCred(ctx, sub, "navidrome");
  const secret = c ? parseSecret(c.secret) : null;
  return c && secret ? { url: c.url, secret } : null;
}

export const einmusicModule: BffModule = {
  id: "einmusic",

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "einmusic_library",
        description:
          "List the user's EinMusic library — uploaded tracks and playlists with their track counts.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          return {
            tracks: ctx.store.listMusicTracks(sub).map((t) => ({
              id: t.id,
              title: t.title,
              bytes: t.bytes,
            })),
            playlists: ctx.store.listMusicPlaylists(sub),
          };
        },
      },
    ];
  },

  register(api, ctx) {
    // Raw-body upload: the MP3 bytes are the request body (D48).
    api.addContentTypeParser(
      ["audio/mpeg", "application/octet-stream"],
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    api.get("/tracks", async (req) => ({
      tracks: ctx.store.listMusicTracks(req.user.sub),
    }));

    api.post("/tracks", { bodyLimit: 50 * 1024 * 1024 }, async (req, reply) => {
      const name = (req.query as { name?: string }).name;
      if (!name) return reply.code(400).send({ error: "expected ?name=<file.mp3>" });
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ error: "expected the mp3 bytes as the request body" });
      }
      const { title } = parseTrackName(name);
      const track = ctx.store.createMusicTrack(req.user.sub, title, body.length);
      try {
        writeFileSync(trackFile(ctx, track.id), body);
      } catch (e) {
        ctx.store.deleteMusicTrack(req.user.sub, track.id);
        throw e;
      }
      return reply.code(201).send({ track });
    });

    api.get("/tracks/:id/stream", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const track = Number.isInteger(id) ? ctx.store.getMusicTrack(req.user.sub, id) : undefined;
      if (!track) return reply.code(404).send({ error: "not found" });
      const file = trackFile(ctx, track.id);
      const size = statSync(file).size;

      reply.header("Content-Type", "audio/mpeg").header("Accept-Ranges", "bytes");
      const range = req.headers.range;
      const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
      if (range && m && (m[1] !== "" || m[2] !== "")) {
        const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
        const end = m[2] === "" || m[1] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
        if (start >= size || start > end) {
          return reply.code(416).header("Content-Range", `bytes */${size}`).send();
        }
        return reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${size}`)
          .header("Content-Length", end - start + 1)
          .send(createReadStream(file, { start, end }));
      }
      if (range) {
        return reply.code(416).header("Content-Range", `bytes */${size}`).send();
      }
      return reply.header("Content-Length", size).send(createReadStream(file));
    });

    api.delete("/tracks/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!ctx.store.deleteMusicTrack(req.user.sub, id)) {
        return reply.code(404).send({ error: "not found" });
      }
      unlinkSync(trackFile(ctx, id));
      return { deleted: true };
    });

    api.get("/playlists", async (req) => ({
      playlists: ctx.store.listMusicPlaylists(req.user.sub),
    }));

    api.post("/playlists", async (req, reply) => {
      const parsed = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {name}" });
      return reply
        .code(201)
        .send({ playlist: ctx.store.createMusicPlaylist(req.user.sub, parsed.data.name) });
    });

    api.get("/playlists/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const playlist = Number.isInteger(id)
        ? ctx.store.getMusicPlaylist(req.user.sub, id)
        : undefined;
      if (!playlist) return reply.code(404).send({ error: "not found" });
      return { playlist, tracks: ctx.store.listPlaylistTracks(playlist.id) };
    });

    api.put("/playlists/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      const playlist = Number.isInteger(id)
        ? ctx.store.getMusicPlaylist(req.user.sub, id)
        : undefined;
      if (!playlist) return reply.code(404).send({ error: "not found" });
      const parsed = putPlaylistSchema.safeParse(req.body);
      if (!parsed.success || (!parsed.data.name && !parsed.data.trackIds)) {
        return reply.code(400).send({ error: "expected {name?} or {trackIds?}" });
      }
      if (parsed.data.trackIds) {
        const owned = new Set(ctx.store.listMusicTracks(req.user.sub).map((t) => t.id));
        if (parsed.data.trackIds.some((t) => !owned.has(t))) {
          return reply.code(400).send({ error: "trackIds must be own tracks" });
        }
        ctx.store.setPlaylistTracks(playlist.id, parsed.data.trackIds);
      }
      if (parsed.data.name)
        ctx.store.renameMusicPlaylist(req.user.sub, playlist.id, parsed.data.name);
      return { playlist: ctx.store.getMusicPlaylist(req.user.sub, playlist.id) };
    });

    api.delete("/playlists/:id", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!ctx.store.deleteMusicPlaylist(req.user.sub, id)) {
        return reply.code(404).send({ error: "not found" });
      }
      return { deleted: true };
    });

    // --- Navidrome bridging (reuses the sealed Subsonic credential, D41) ---

    api.get("/navidrome/playlists", async (req, reply) => {
      const cred = navidromeCred(ctx, req.user.sub);
      if (!cred) return reply.code(424).send({ error: "navidrome not connected" });
      const res = await subsonic<{ playlists?: { playlist?: SubsonicPlaylist[] } }>(
        ctx.fetchImpl ?? fetch,
        cred.url,
        cred.secret,
        "getPlaylists.view",
      );
      if (!res.data) return reply.code(res.status === 401 ? 401 : 502).send({ error: "navidrome" });
      return {
        playlists: (res.data.playlists?.playlist ?? []).map((p) => ({
          id: p.id ?? "",
          name: p.name ?? "",
          songCount: p.songCount ?? 0,
        })),
      };
    });

    api.get("/navidrome/playlists/:id", async (req, reply) => {
      const cred = navidromeCred(ctx, req.user.sub);
      if (!cred) return reply.code(424).send({ error: "navidrome not connected" });
      const id = (req.params as { id: string }).id;
      const res = await subsonic<{ playlist?: SubsonicPlaylist }>(
        ctx.fetchImpl ?? fetch,
        cred.url,
        cred.secret,
        "getPlaylist.view",
        `&id=${encodeURIComponent(id)}`,
      );
      const p = res.data?.playlist;
      if (!p) return reply.code(res.status === 401 ? 401 : 502).send({ error: "navidrome" });
      return {
        playlist: { id: p.id ?? id, name: p.name ?? "" },
        tracks: (p.entry ?? []).map((e) => ({
          id: e.id ?? "",
          title: e.title ?? "",
          artist: e.artist ?? null,
          album: e.album ?? null,
          duration: e.duration ?? null,
        })),
      };
    });

    api.get("/navidrome/stream", async (req, reply) => {
      const cred = navidromeCred(ctx, req.user.sub);
      if (!cred) return reply.code(424).send({ error: "navidrome not connected" });
      const songId = (req.query as { songId?: string }).songId;
      if (!songId) return reply.code(400).send({ error: "expected ?songId=" });
      const url = `${normalizeBase(cred.url)}/rest/stream.view?${authParams(cred.secret)}&id=${encodeURIComponent(songId)}`;
      const res = await (ctx.fetchImpl ?? fetch)(url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok || !res.body) {
        return reply.code(res.status === 401 ? 401 : 502).send({ error: "navidrome stream" });
      }
      const type = res.headers.get("content-type") ?? "audio/mpeg";
      const length = res.headers.get("content-length");
      const r = reply.header("Content-Type", type);
      if (length) r.header("Content-Length", length);
      return r.send(Buffer.from(await res.arrayBuffer()));
    });
  },
};
