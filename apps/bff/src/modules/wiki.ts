import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { LlmClient } from "../llm/client.js";
import { type AuthenticatedNextcloud, NextcloudError } from "../nextcloud/client.js";
import type { BffModule, ChatTool } from "./types.js";

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

export interface WikiLlmStatus {
  configured: boolean;
  indexing: boolean;
  pages: number;
  indexedPages: number;
  chunks: number;
}

export interface WikiIndexResult {
  pages: number;
  /** Pages whose etag changed since their last embedding (re-indexed now). */
  embeddedPages: number;
  chunks: number;
}

export interface WikiAskResult {
  answer: string;
  sources: { path: string; title: string }[];
}

/** ~1–2 kB markdown chunks; heading sections are kept together where possible (D39). */
const CHUNK_MAX_CHARS = 1800;

/** Splits markdown into ≤maxChars chunks: heading sections pack until the limit, oversized ones split on paragraph/line/space boundaries. */
export function chunkMarkdown(content: string, maxChars = CHUNK_MAX_CHARS): string[] {
  const sections = content.split(/(?=^#{1,6} )/m);
  const out: string[] = [];
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) out.push(t);
    current = "";
  };
  for (const section of sections) {
    for (const piece of splitLong(section, maxChars)) {
      if (current && current.length + piece.length + 2 > maxChars) flush();
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  flush();
  return out;
}

/** Hard-splits text longer than maxChars — prefers paragraph, then line, then word boundaries. */
function splitLong(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars / 2) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars / 2) cut = rest.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const toF32 = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromF32 = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

function cosine(a: number[], b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const ASK_SYSTEM_PROMPT = [
  "You answer questions about the user's wiki using only the context excerpts provided.",
  "If the context does not contain the answer, say so plainly — do not guess or use outside knowledge.",
  "Keep answers concise and in the same language as the question.",
  "When you use information from a page, mention its path (### path) as the source.",
].join(" ");

/** Provider calls batch this many inputs per /embeddings request. */
const EMBED_BATCH = 32;

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
  // Chunk index is derived data — prune it in lockstep with the mirror.
  store.pruneWikiChunks(
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

  /** Lends EinChat RAG retrieval over the mirrored pages (D41). Absent without LLM_*. */
  chatTools(ctx): ChatTool[] {
    const llm = ctx.llm;
    if (!llm) return [];
    return [
      {
        name: "wiki_search",
        description:
          "Search the user's mirrored Nextcloud wiki/collectives pages. Returns the most relevant passages with page path and title. Use for questions about the user's notes and knowledge base.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look for, as a short phrase" },
          },
          required: ["query"],
        },
        async call(args, sub) {
          const q = typeof args.query === "string" ? args.query.trim() : "";
          if (!q) return { error: "empty_query" };
          const chunks = ctx.store.listWikiChunks(sub).filter((c) => c.embedding);
          if (chunks.length === 0) {
            return {
              error: "not_indexed",
              hint: "User must run 'Update index' in the Wiki module",
            };
          }
          const [qv] = await llm.client.embed(llm.embedModel, [q]);
          const ranked = chunks
            .map((c) => ({ c, score: cosine(qv ?? [], fromF32(c.embedding as Buffer)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, llm.topK);
          return {
            matches: ranked.map(({ c }) => ({
              path: c.path,
              title: metaFromPath(c.path).title,
              text: c.text,
            })),
          };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const { store, secrets, nextcloud } = ctx;
    // One sync per user at a time — concurrent callers share the in-flight promise.
    const inflight = new Map<string, Promise<WikiSyncResult>>();
    const indexInflight = new Map<string, Promise<WikiIndexResult>>();
    // Shared LLM provider (D41) — null when LLM_URL/models are unconfigured.
    const llm = ctx.llm?.client ?? null;
    const llmEmbed = ctx.llm?.embedModel;
    const llmChat = ctx.llm?.chatModel;
    const llmTopK = ctx.llm?.topK ?? 8;

    const runIndex = (sub: string): Promise<WikiIndexResult> => {
      const running = indexInflight.get(sub);
      if (running) return running;
      const p = doIndex(sub).finally(() => indexInflight.delete(sub));
      indexInflight.set(sub, p);
      return p;
    };

    /** Re-embeds pages whose etag changed and prunes chunks of deleted pages. */
    const doIndex = async (sub: string): Promise<WikiIndexResult> => {
      const pages = store.listWikiPages(sub);
      store.pruneWikiChunks(
        sub,
        pages.map((p) => p.path),
      );
      const chunkEtags = store.wikiChunkEtags(sub);
      let embeddedPages = 0;
      let chunks = 0;
      for (const page of pages) {
        if (chunkEtags.get(page.path) === page.etag) continue; // already indexed
        const full = store.getWikiPage(sub, page.path);
        if (!full) continue;
        const parts = chunkMarkdown(full.content);
        // The title is part of the embedding input so title-bearing queries rank well.
        const vectors = llm
          ? await embedAll(llm, llmEmbed as string, [
              ...parts.map((part) => `${full.title}\n\n${part}`),
            ])
          : [];
        store.replaceWikiChunks(
          sub,
          page.path,
          page.etag,
          parts.map((text, i) => ({ text, embedding: vectors[i] ? toF32(vectors[i]) : null })),
        );
        embeddedPages += 1;
        chunks += parts.length;
      }
      return { pages: pages.length, embeddedPages, chunks };
    };

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
      // Index in the background after a successful sync — never blocks the mirror.
      if (llm) {
        void p
          .then(() => runIndex(sub))
          .catch((e) => api.log.warn({ err: e }, "wiki llm index failed"));
      }
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

    api.get("/llm/status", async (request) => {
      const stats = store.wikiChunkStats(request.user.sub);
      return {
        configured: llm !== null,
        indexing: indexInflight.has(request.user.sub),
        pages: store.listWikiPages(request.user.sub).length,
        indexedPages: stats.pages,
        chunks: stats.chunks,
      } satisfies WikiLlmStatus;
    });

    api.post("/llm/index", async (request, reply) => {
      if (!llm) return reply.code(424).send({ error: "llm not configured" });
      return runIndex(request.user.sub);
    });

    api.post("/ask", async (request, reply) => {
      if (!llm) return reply.code(424).send({ error: "llm not configured" });
      const { question } = (request.body ?? {}) as { question?: unknown };
      const q = typeof question === "string" ? question.trim() : "";
      if (!q || q.length > 2000) {
        return reply.code(400).send({ error: "question must be 1-2000 characters" });
      }
      const chunks = store.listWikiChunks(request.user.sub).filter((c) => c.embedding);
      if (chunks.length === 0) {
        return reply.code(409).send({ error: "wiki not indexed" });
      }
      const [qv] = await llm.embed(llmEmbed as string, [q]);
      const ranked = chunks
        .map((c) => ({ c, score: cosine(qv ?? [], fromF32(c.embedding as Buffer)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, llmTopK);
      const context = ranked.map(({ c }) => `### ${c.path}\n${c.text}`).join("\n\n");
      const answer = await llm.chat(llmChat as string, [
        { role: "system", content: ASK_SYSTEM_PROMPT },
        { role: "user", content: `Context:\n\n${context}\n\nQuestion: ${q}` },
      ]);
      const sources = [...new Set(ranked.map(({ c }) => c.path))].map((path) => ({
        path,
        title: metaFromPath(path).title,
      }));
      return { answer, sources } satisfies WikiAskResult;
    });
  },
};

/** Embeds texts in batches — one request per EMBED_BATCH inputs keeps payloads sane. */
async function embedAll(client: LlmClient, model: string, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    out.push(...(await client.embed(model, texts.slice(i, i + EMBED_BATCH))));
  }
  return out;
}

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
