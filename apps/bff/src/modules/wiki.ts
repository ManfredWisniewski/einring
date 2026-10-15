import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { AppContext } from "../app.js";
import { type AuthenticatedNextcloud, NextcloudError } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

export interface WikiPageMeta {
  path: string;
  title: string;
  collective: string;
  mtime: string | null;
}

export interface WikiTree {
  syncedAt: string | null;
  pages: WikiPageMeta[];
}

export interface WikiPage extends WikiPageMeta {
  content: string;
}

export interface WikiSearchResult extends WikiPageMeta {
  snippet: string;
}

export interface WikiSyncResult {
  syncedAt: string;
  pages: number;
}

/** "Handbook/Onboarding.md" → collective "Handbook", title "Onboarding". */
export function metaFromPath(path: string): { collective: string; title: string } {
  const segments = path.split("/");
  const file = segments.at(-1) ?? path;
  return {
    collective: segments[0] ?? "",
    title: file.replace(/\.(md|markdown)$/i, "").replaceAll("_", " "),
  };
}

interface SourceFile {
  /** Store path relative to the collective root, e.g. "Handbook/Intro.md". */
  relPath: string;
  etag?: string;
  lastModified?: string;
}

/** A wiki content source: lists markdown files and reads them. */
export interface WikiSource {
  list(): Promise<SourceFile[]>;
  read(relPath: string): Promise<string>;
}

/**
 * `<user>/<mount>/` via WebDAV. The mount folder is per-user configurable in the
 * Collectives app, so it is resolved via `settings/user/user_folder` first;
 * the configured ROOT and legacy `Collectives` are probed as fallbacks.
 */
function davSource(nc: AuthenticatedNextcloud, defaultRoot: string): WikiSource {
  let root: string | null = null;

  const resolveRoot = async (): Promise<string | null> => {
    if (root) return root;
    const candidates: string[] = [defaultRoot, "Collectives"];
    try {
      const setting = await nc.getCollectivesUserSetting("user_folder");
      const folder = Object.values(setting.ocs.data ?? {})[0]
        ?.trim()
        .replace(/^\/+|\/+$/g, "");
      if (folder) candidates.unshift(folder);
    } catch (e) {
      // HTTP failure = setting endpoint unavailable; other errors are real bugs.
      if (!(e instanceof NextcloudError)) throw e;
    }
    for (const candidate of [...new Set(candidates)]) {
      try {
        await nc.davPropfind(candidate, 1);
        root = candidate;
        return root;
      } catch (e) {
        if ((e as NextcloudError).status !== 404) throw e;
      }
    }
    return null; // no collectives folder — app absent or user has none
  };

  return {
    async list() {
      const base = await resolveRoot();
      if (!base) return [];
      const files: SourceFile[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await nc.davPropfind(dir, 1)) {
          if (entry.relPath === dir) continue; // the directory itself
          if (entry.isCollection) await walk(entry.relPath);
          else if (/\.(md|markdown)$/i.test(entry.relPath)) {
            files.push({
              relPath: entry.relPath.slice(base.length + 1),
              etag: entry.etag,
              lastModified: entry.lastModified,
            });
          }
        }
      };
      await walk(base);
      return files;
    },
    read: async (relPath) => {
      const base = (await resolveRoot()) ?? defaultRoot;
      return nc.davGetFile(`${base}/${relPath}`);
    },
  };
}

/**
 * Local directory as a single collective named after the directory — dev seeding
 * (`MODULE_WIKI_SOURCE_DIR`). Dot-dirs (`.obsidian`, `.templates`) are skipped.
 */
export function fsSource(root: string): WikiSource {
  const collective = basename(root);
  return {
    async list() {
      const files: SourceFile[] = [];
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const ent of await readdir(dir, { withFileTypes: true })) {
          if (ent.name.startsWith(".")) continue;
          const abs = join(dir, ent.name);
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          if (ent.isDirectory()) await walk(abs, rel);
          else if (/\.(md|markdown)$/i.test(ent.name)) {
            const s = await stat(abs);
            files.push({
              relPath: `${collective}/${rel}`,
              etag: `${s.mtimeMs}-${s.size}`,
              lastModified: s.mtime.toISOString(),
            });
          }
        }
      };
      await walk(root, "");
      return files;
    },
    read: (relPath) => readFile(join(root, relPath.slice(collective.length + 1)), "utf8"),
  };
}

/** Mirrors a source's markdown files into the store: upsert changed, prune deleted. */
export async function syncWiki(
  source: WikiSource,
  ctx: Pick<AppContext, "store">,
  sub: string,
): Promise<WikiSyncResult> {
  const { store } = ctx;
  const files = await source.list();

  const syncedAt = new Date().toISOString();
  const known = store.wikiEtags(sub);
  for (const f of files) {
    if (f.etag && known.get(f.relPath) === f.etag) continue; // unchanged
    const content = await source.read(f.relPath);
    store.upsertWikiPage({
      sub,
      path: f.relPath,
      title: metaFromPath(f.relPath).title,
      content,
      etag: f.etag ?? "",
      mtime: f.lastModified ?? null,
      syncedAt,
    });
  }
  store.pruneWikiPages(
    sub,
    files.map((f) => f.relPath),
  );
  store.setWikiSyncedAt(sub, syncedAt);
  return { syncedAt, pages: files.length };
}

const configSchema = z.object({
  /** Seconds a sync result is reused before /tree refreshes it. */
  SYNC_TTL_S: z.coerce.number().int().min(0).default(300),
  /**
   * Fallback DAV folder holding the collectives, used when the per-user
   * `user_folder` setting can't be read. Current Nextcloud default is
   * `.Collectives`; older installs used `Collectives` (also probed).
   */
  ROOT: z.string().min(1).default(".Collectives"),
  /**
   * Dev seeding: sync reads this local directory (basename = collective name)
   * instead of Nextcloud WebDAV.
   */
  SOURCE_DIR: z.string().min(1).optional(),
});

export const wikiModule: BffModule<z.infer<typeof configSchema>> = {
  id: "wiki",
  requires: ["nextcloud"],
  configSchema,
  register(api, ctx, config) {
    const { store, secrets, nextcloud } = ctx;
    // One sync per user at a time — concurrent callers share the in-flight promise.
    const inflight = new Map<string, Promise<WikiSyncResult>>();

    const sync = (sub: string): Promise<WikiSyncResult> => {
      const running = inflight.get(sub);
      if (running) return running;
      const cred = store.getCredential(sub);
      if (!cred) return Promise.reject(new Error("nextcloud not connected"));
      const source = config.SOURCE_DIR
        ? fsSource(config.SOURCE_DIR)
        : davSource(
            nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed)),
            config.ROOT,
          );
      const p = syncWiki(source, ctx, sub).finally(() => inflight.delete(sub));
      inflight.set(sub, p);
      return p;
    };

    const credFor = (sub: string) => (store.getCredential(sub) ? sub : null);

    api.get("/tree", async (request, reply) => {
      if (!credFor(request.user.sub)) {
        return reply.code(424).send({ error: "nextcloud not connected" });
      }
      const lastSync = store.getWikiSyncedAt(request.user.sub);
      const stale = !lastSync || Date.now() - Date.parse(lastSync) > config.SYNC_TTL_S * 1000;
      if (stale) await sync(request.user.sub);
      return {
        syncedAt: store.getWikiSyncedAt(request.user.sub) ?? null,
        pages: store.listWikiPages(request.user.sub).map((p) => ({
          ...metaFromPath(p.path),
          path: p.path,
          mtime: p.mtime,
        })),
      } satisfies WikiTree;
    });

    api.post("/sync", async (request, reply) => {
      if (!credFor(request.user.sub)) {
        return reply.code(424).send({ error: "nextcloud not connected" });
      }
      return sync(request.user.sub);
    });

    api.get("/page", async (request, reply) => {
      const { path } = request.query as { path?: string };
      const page = path ? store.getWikiPage(request.user.sub, path) : undefined;
      if (!page) return reply.code(404).send({ error: "page not found" });
      return {
        ...metaFromPath(page.path),
        path: page.path,
        content: page.content,
        mtime: page.mtime,
      } satisfies WikiPage;
    });

    api.get("/search", async (request) => {
      const { q } = request.query as { q?: string };
      if (!q?.trim()) return { results: [] };
      const needle = q.trim().toLowerCase();
      const results: WikiSearchResult[] = store.searchWiki(request.user.sub, needle).map((r) => ({
        ...metaFromPath(r.path),
        path: r.path,
        mtime: null,
        snippet: snippet(r.content, needle),
      }));
      return { results };
    });
  },
};

/** ~160 chars of context around the first case-insensitive match. */
function snippet(content: string, needle: string): string {
  const i = content.toLowerCase().indexOf(needle);
  if (i < 0) return "";
  const start = Math.max(0, i - 60);
  const text = content
    .slice(start, i + needle.length + 100)
    .replaceAll("\n", " ")
    .trim();
  return (start > 0 ? "…" : "") + text + (start + text.length < content.length ? "…" : "");
}
