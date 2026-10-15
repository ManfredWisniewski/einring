import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NextcloudCredential {
  sub: string;
  server: string;
  loginName: string;
  appPasswordSealed: string;
}

export interface PendingLoginFlow {
  sub: string;
  pollToken: string;
  pollEndpoint: string;
}

/** A mirrored Collectives page. `path` is relative to the Collectives root ("Handbook/Intro.md"). */
export interface WikiPageRow {
  sub: string;
  path: string;
  title: string;
  content: string;
  etag: string;
  mtime: string | null;
  syncedAt: string;
}

export interface Store {
  getCredential(sub: string): NextcloudCredential | undefined;
  saveCredential(cred: NextcloudCredential): void;
  deleteCredential(sub: string): void;
  getPendingFlow(sub: string): PendingLoginFlow | undefined;
  savePendingFlow(flow: PendingLoginFlow): void;
  deletePendingFlow(sub: string): void;
  listWikiPages(sub: string): Omit<WikiPageRow, "content" | "sub">[];
  getWikiPage(sub: string, path: string): WikiPageRow | undefined;
  /** path→etag map, for change detection during sync. */
  wikiEtags(sub: string): Map<string, string>;
  upsertWikiPage(page: WikiPageRow): void;
  /** Deletes all pages of `sub` not in `keepPaths` (empty = delete all). */
  pruneWikiPages(sub: string, keepPaths: string[]): void;
  /** LIKE search over title + content; returns full rows for snippet extraction. */
  searchWiki(sub: string, query: string): Pick<WikiPageRow, "path" | "title" | "content">[];
  getWikiSyncedAt(sub: string): string | undefined;
  setWikiSyncedAt(sub: string, at: string): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nextcloud_credentials (
  sub TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  login_name TEXT NOT NULL,
  app_password_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS login_flows (
  sub TEXT PRIMARY KEY,
  poll_token TEXT NOT NULL,
  poll_endpoint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wiki_pages (
  sub TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  etag TEXT NOT NULL,
  mtime TEXT,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (sub, path)
);
CREATE TABLE IF NOT EXISTS wiki_sync (
  sub TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
`;

/** `path` may be ":memory:" for tests. */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);

  const getCred = db.prepare(
    "SELECT sub, server, login_name AS loginName, app_password_sealed AS appPasswordSealed FROM nextcloud_credentials WHERE sub = ?",
  );
  const putCred = db.prepare(
    `INSERT INTO nextcloud_credentials (sub, server, login_name, app_password_sealed) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET server = excluded.server, login_name = excluded.login_name,
       app_password_sealed = excluded.app_password_sealed, created_at = datetime('now')`,
  );
  const delCred = db.prepare("DELETE FROM nextcloud_credentials WHERE sub = ?");
  const getFlow = db.prepare(
    "SELECT sub, poll_token AS pollToken, poll_endpoint AS pollEndpoint FROM login_flows WHERE sub = ?",
  );
  const putFlow = db.prepare(
    `INSERT INTO login_flows (sub, poll_token, poll_endpoint) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET poll_token = excluded.poll_token, poll_endpoint = excluded.poll_endpoint,
       created_at = datetime('now')`,
  );
  const delFlow = db.prepare("DELETE FROM login_flows WHERE sub = ?");
  const listPages = db.prepare(
    "SELECT path, title, etag, mtime, synced_at AS syncedAt FROM wiki_pages WHERE sub = ? ORDER BY path",
  );
  const getPage = db.prepare(
    "SELECT sub, path, title, content, etag, mtime, synced_at AS syncedAt FROM wiki_pages WHERE sub = ? AND path = ?",
  );
  const pageEtags = db.prepare("SELECT path, etag FROM wiki_pages WHERE sub = ?");
  const putPage = db.prepare(
    `INSERT INTO wiki_pages (sub, path, title, content, etag, mtime, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sub, path) DO UPDATE SET title = excluded.title, content = excluded.content,
       etag = excluded.etag, mtime = excluded.mtime, synced_at = excluded.synced_at`,
  );
  const searchPages = db.prepare(
    `SELECT path, title, content FROM wiki_pages WHERE sub = ?
       AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY path`,
  );
  const getSync = db.prepare("SELECT at FROM wiki_sync WHERE sub = ?");
  const putSync = db.prepare(
    `INSERT INTO wiki_sync (sub, at) VALUES (?, ?) ON CONFLICT(sub) DO UPDATE SET at = excluded.at`,
  );

  const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

  return {
    getCredential: (sub) => getCred.get(sub) as NextcloudCredential | undefined,
    saveCredential: (c) => void putCred.run(c.sub, c.server, c.loginName, c.appPasswordSealed),
    deleteCredential: (sub) => void delCred.run(sub),
    getPendingFlow: (sub) => getFlow.get(sub) as PendingLoginFlow | undefined,
    savePendingFlow: (f) => void putFlow.run(f.sub, f.pollToken, f.pollEndpoint),
    deletePendingFlow: (sub) => void delFlow.run(sub),
    listWikiPages: (sub) => listPages.all(sub) as Omit<WikiPageRow, "content" | "sub">[],
    getWikiPage: (sub, path) => getPage.get(sub, path) as WikiPageRow | undefined,
    wikiEtags: (sub) =>
      new Map(
        (pageEtags.all(sub) as { path: string; etag: string }[]).map((r) => [r.path, r.etag]),
      ),
    upsertWikiPage: (p) =>
      void putPage.run(p.sub, p.path, p.title, p.content, p.etag, p.mtime, p.syncedAt),
    pruneWikiPages: (sub, keepPaths) => {
      if (keepPaths.length === 0) {
        db.prepare("DELETE FROM wiki_pages WHERE sub = ?").run(sub);
        return;
      }
      const placeholders = keepPaths.map(() => "?").join(", ");
      db.prepare(`DELETE FROM wiki_pages WHERE sub = ? AND path NOT IN (${placeholders})`).run(
        sub,
        ...keepPaths,
      );
    },
    searchWiki: (sub, query) =>
      searchPages.all(sub, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`) as Pick<
        WikiPageRow,
        "path" | "title" | "content"
      >[],
    getWikiSyncedAt: (sub) => (getSync.get(sub) as { at: string } | undefined)?.at,
    setWikiSyncedAt: (sub, at) => void putSync.run(sub, at),
    close: () => db.close(),
  };
}
