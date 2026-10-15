import { z } from "zod";
import type { AppContext } from "../app.js";
import type { AuthenticatedNextcloud, NextcloudError } from "../nextcloud/client.js";
import type { BffModule } from "./types.js";

const COLLECTIVES_ROOT = "Collectives";

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

/** Walks `<user>/Collectives/` via WebDAV and mirrors all `.md` files into the store. */
export async function syncWiki(
  nc: AuthenticatedNextcloud,
  ctx: Pick<AppContext, "store">,
  sub: string,
): Promise<WikiSyncResult> {
  const { store } = ctx;
  const files: { relPath: string; etag?: string; lastModified?: string }[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Awaited<ReturnType<AuthenticatedNextcloud["davPropfind"]>>;
    try {
      entries = await nc.davPropfind(dir, 1);
    } catch (e) {
      if (dir === COLLECTIVES_ROOT && (e as NextcloudError).status === 404) return; // app absent
      throw e;
    }
    for (const entry of entries) {
      if (entry.relPath === dir) continue; // the directory itself
      if (entry.isCollection) await walk(entry.relPath);
      else if (/\.(md|markdown)$/i.test(entry.relPath)) {
        files.push({ relPath: entry.relPath, etag: entry.etag, lastModified: entry.lastModified });
      }
    }
  };
  await walk(COLLECTIVES_ROOT);

  const syncedAt = new Date().toISOString();
  const known = store.wikiEtags(sub);
  for (const f of files) {
    const rel = f.relPath.slice(COLLECTIVES_ROOT.length + 1); // strip "Collectives/"
    if (f.etag && known.get(rel) === f.etag) continue; // unchanged
    const content = await nc.davGetFile(f.relPath);
    store.upsertWikiPage({
      sub,
      path: rel,
      title: metaFromPath(rel).title,
      content,
      etag: f.etag ?? "",
      mtime: f.lastModified ?? null,
      syncedAt,
    });
  }
  store.pruneWikiPages(
    sub,
    files.map((f) => f.relPath.slice(COLLECTIVES_ROOT.length + 1)),
  );
  store.setWikiSyncedAt(sub, syncedAt);
  return { syncedAt, pages: files.length };
}

const configSchema = z.object({
  /** Seconds a sync result is reused before /tree refreshes it. */
  SYNC_TTL_S: z.coerce.number().int().min(0).default(300),
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
      const nc = nextcloud.withCredentials(cred.loginName, secrets.open(cred.appPasswordSealed));
      const p = syncWiki(nc, ctx, sub).finally(() => inflight.delete(sub));
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
