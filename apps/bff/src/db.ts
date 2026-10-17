import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface NextcloudCredential {
  sub: string;
  server: string;
  /** Nextcloud's internal user id — opaque hash under SSO backends; not for display. */
  loginName: string;
  /** Human-readable name from `ocs/v2.php/cloud/user`; null until resolved. */
  displayName?: string | null;
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

/** An embedded chunk of a mirrored wiki page (RAG index, D39). `embedding` is a Float32 blob. */
export type WikiChunkRow = {
  sub: string;
  path: string;
  chunkIdx: number;
  text: string;
  embedding: Buffer | null;
  /** Page etag at embed time — stale chunks are re-embedded on the next index run. */
  etag: string;
};

/** An imported CSV file; `headers` is a JSON array of column names. */
export interface CsvFileRow {
  id: number;
  sub: string;
  name: string;
  headers: string;
  createdAt: string;
}

/** A CSV data row; `cells` is a JSON array aligned to the file's headers. `done` is einring-level row state. */
export type CsvRowRow = {
  id: number;
  fileId: number;
  cells: string;
  done: number;
};

/** A per-user credential for an external service connector (D41) — `service` is the module id. */
export interface ServiceCredential {
  sub: string;
  service: string;
  url: string | null;
  secretSealed: string;
}

export interface Store {
  getCredential(sub: string): NextcloudCredential | undefined;
  saveCredential(cred: NextcloudCredential): void;
  deleteCredential(sub: string): void;
  /** Connector-module credentials, sealed like Nextcloud app passwords. */
  getServiceCredential(sub: string, service: string): ServiceCredential | undefined;
  saveServiceCredential(cred: ServiceCredential): void;
  deleteServiceCredential(sub: string, service: string): void;
  /** Per-user JSON blob a module owns (e.g. einchat's tool selection). */
  getModuleSettings(sub: string, module: string): string | undefined;
  saveModuleSettings(sub: string, module: string, data: string): void;
  /** Pending flows expire after 10 min — stale rows read as "no pending flow". */
  getPendingFlow(sub: string): PendingLoginFlow | undefined;
  savePendingFlow(flow: PendingLoginFlow): void;
  deletePendingFlow(sub: string): void;
  /** Embedded-mode sessions: token is stored as its sha256 hash, never in clear. */
  saveSession(tokenHash: string, sub: string, expiresAt: string): void;
  /** The session's sub, or undefined for unknown/expired tokens (expired rows are pruned on read). */
  getSessionSub(tokenHash: string): string | undefined;
  /** Drops all sessions of a user (called on Nextcloud disconnect). */
  deleteSessionsForSub(sub: string): void;
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
  /** All chunks of a user, ordered by path + position — the RAG retrieval corpus. */
  listWikiChunks(sub: string): WikiChunkRow[];
  /** path→etag of pages with indexed chunks, for change detection during indexing. */
  wikiChunkEtags(sub: string): Map<string, string>;
  /** Replaces all chunks of a page atomically (delete + insert). */
  replaceWikiChunks(
    sub: string,
    path: string,
    etag: string,
    chunks: { text: string; embedding: Buffer | null }[],
  ): void;
  /** Deletes all chunks of `sub` not in `keepPaths` (empty = delete all). */
  pruneWikiChunks(sub: string, keepPaths: string[]): void;
  /** Chunk count + distinct indexed pages. */
  wikiChunkStats(sub: string): { chunks: number; pages: number };
  listCsvFiles(sub: string): (Omit<CsvFileRow, "sub"> & { rowCount: number })[];
  getCsvFile(sub: string, id: number): Omit<CsvFileRow, "sub"> | undefined;
  /** Returns the created row. */
  createCsvFile(sub: string, name: string, headers: string[]): Omit<CsvFileRow, "sub">;
  /** Bulk insert at import time; atomic. */
  insertCsvRows(fileId: number, rows: string[][]): void;
  listCsvRows(fileId: number): CsvRowRow[];
  getCsvRow(fileId: number, rowId: number): CsvRowRow | undefined;
  /** Returns the new row id. Cells are padded/truncated by the caller. */
  addCsvRow(fileId: number, cells: string[]): number;
  /** Only the provided fields are updated. False when nothing changed or the row doesn't exist. */
  updateCsvRow(fileId: number, rowId: number, patch: { cells?: string[]; done?: boolean }): boolean;
  deleteCsvRow(fileId: number, rowId: number): boolean;
  /** Deletes the file and its rows; false when the sub doesn't own `id`. */
  deleteCsvFile(sub: string, id: number): boolean;
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
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS csv_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  name TEXT NOT NULL,
  headers TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS csv_files_sub ON csv_files(sub);
CREATE TABLE IF NOT EXISTS csv_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  cells TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS csv_rows_file ON csv_rows(file_id);
CREATE TABLE IF NOT EXISTS wiki_chunks (
  sub TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  etag TEXT NOT NULL,
  PRIMARY KEY (sub, path, chunk_idx)
);
CREATE INDEX IF NOT EXISTS wiki_chunks_sub ON wiki_chunks(sub);
CREATE TABLE IF NOT EXISTS service_credentials (
  sub TEXT NOT NULL,
  service TEXT NOT NULL,
  url TEXT,
  secret_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sub, service)
);
CREATE TABLE IF NOT EXISTS module_settings (
  sub TEXT NOT NULL,
  module TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (sub, module)
);
`;

/** Additive migrations for existing databases (SCHEMA covers fresh ones). */
function migrate(db: DatabaseSync) {
  const cols = db.prepare("PRAGMA table_info(nextcloud_credentials)").all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "display_name")) {
    db.exec("ALTER TABLE nextcloud_credentials ADD COLUMN display_name TEXT");
  }
}

/** `path` may be ":memory:" for tests. */
export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  migrate(db);

  const getCred = db.prepare(
    "SELECT sub, server, login_name AS loginName, display_name AS displayName, app_password_sealed AS appPasswordSealed FROM nextcloud_credentials WHERE sub = ?",
  );
  const putCred = db.prepare(
    `INSERT INTO nextcloud_credentials (sub, server, login_name, display_name, app_password_sealed) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET server = excluded.server, login_name = excluded.login_name,
       display_name = excluded.display_name,
       app_password_sealed = excluded.app_password_sealed, created_at = datetime('now')`,
  );
  const delCred = db.prepare("DELETE FROM nextcloud_credentials WHERE sub = ?");
  const getSvcCred = db.prepare(
    "SELECT sub, service, url, secret_sealed AS secretSealed FROM service_credentials WHERE sub = ? AND service = ?",
  );
  const putSvcCred = db.prepare(
    `INSERT INTO service_credentials (sub, service, url, secret_sealed) VALUES (?, ?, ?, ?)
     ON CONFLICT(sub, service) DO UPDATE SET url = excluded.url,
       secret_sealed = excluded.secret_sealed, created_at = datetime('now')`,
  );
  const delSvcCred = db.prepare("DELETE FROM service_credentials WHERE sub = ? AND service = ?");
  const getModSettings = db.prepare(
    "SELECT data FROM module_settings WHERE sub = ? AND module = ?",
  );
  const putModSettings = db.prepare(
    `INSERT INTO module_settings (sub, module, data) VALUES (?, ?, ?)
     ON CONFLICT(sub, module) DO UPDATE SET data = excluded.data`,
  );
  const getFlow = db.prepare(
    `SELECT sub, poll_token AS pollToken, poll_endpoint AS pollEndpoint FROM login_flows
     WHERE sub = ? AND created_at > datetime('now', '-10 minutes')`,
  );
  const putFlow = db.prepare(
    `INSERT INTO login_flows (sub, poll_token, poll_endpoint) VALUES (?, ?, ?)
     ON CONFLICT(sub) DO UPDATE SET poll_token = excluded.poll_token, poll_endpoint = excluded.poll_endpoint,
       created_at = datetime('now')`,
  );
  const delFlow = db.prepare("DELETE FROM login_flows WHERE sub = ?");
  const putSession = db.prepare(
    "INSERT INTO sessions (token_hash, sub, expires_at) VALUES (?, ?, ?)",
  );
  const delExpiredSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  const getSession = db.prepare("SELECT sub FROM sessions WHERE token_hash = ?");
  const delSessionsForSub = db.prepare("DELETE FROM sessions WHERE sub = ?");
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
  const listCsv = db.prepare(
    `SELECT f.id, f.name, f.headers, f.created_at AS createdAt,
       (SELECT COUNT(*) FROM csv_rows r WHERE r.file_id = f.id) AS rowCount
     FROM csv_files f WHERE f.sub = ? ORDER BY f.id DESC`,
  );
  const getCsv = db.prepare(
    "SELECT id, name, headers, created_at AS createdAt FROM csv_files WHERE sub = ? AND id = ?",
  );
  const putCsv = db.prepare("INSERT INTO csv_files (sub, name, headers) VALUES (?, ?, ?)");
  const putCsvRow = db.prepare("INSERT INTO csv_rows (file_id, cells, done) VALUES (?, ?, ?)");
  const listRows = db.prepare(
    "SELECT id, file_id AS fileId, cells, done FROM csv_rows WHERE file_id = ? ORDER BY id",
  );
  const getRow = db.prepare(
    "SELECT id, file_id AS fileId, cells, done FROM csv_rows WHERE file_id = ? AND id = ?",
  );
  const delCsvRow = db.prepare("DELETE FROM csv_rows WHERE file_id = ? AND id = ?");
  const delCsvFile = db.prepare("DELETE FROM csv_files WHERE sub = ? AND id = ?");
  const delCsvRowsForFile = db.prepare("DELETE FROM csv_rows WHERE file_id = ?");
  const listChunks = db.prepare(
    "SELECT sub, path, chunk_idx AS chunkIdx, text, embedding, etag FROM wiki_chunks WHERE sub = ? ORDER BY path, chunk_idx",
  );
  const chunkEtags = db.prepare("SELECT path, etag FROM wiki_chunks WHERE sub = ? GROUP BY path");
  const delChunksForPage = db.prepare("DELETE FROM wiki_chunks WHERE sub = ? AND path = ?");
  const putChunk = db.prepare(
    "INSERT INTO wiki_chunks (sub, path, chunk_idx, text, embedding, etag) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const chunkStats = db.prepare(
    "SELECT COUNT(*) AS chunks, COUNT(DISTINCT path) AS pages FROM wiki_chunks WHERE sub = ?",
  );

  const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

  /** Shared by wiki_pages and wiki_chunks — `table` is a fixed string, never user input. */
  const pruneNotIn = (table: "wiki_pages" | "wiki_chunks", sub: string, keepPaths: string[]) => {
    if (keepPaths.length === 0) {
      db.prepare(`DELETE FROM ${table} WHERE sub = ?`).run(sub);
      return;
    }
    const placeholders = keepPaths.map(() => "?").join(", ");
    db.prepare(`DELETE FROM ${table} WHERE sub = ? AND path NOT IN (${placeholders})`).run(
      sub,
      ...keepPaths,
    );
  };

  return {
    getCredential: (sub) => getCred.get(sub) as NextcloudCredential | undefined,
    saveCredential: (c) =>
      void putCred.run(c.sub, c.server, c.loginName, c.displayName ?? null, c.appPasswordSealed),
    deleteCredential: (sub) => void delCred.run(sub),
    getServiceCredential: (sub, service) =>
      getSvcCred.get(sub, service) as ServiceCredential | undefined,
    saveServiceCredential: (c) => void putSvcCred.run(c.sub, c.service, c.url, c.secretSealed),
    deleteServiceCredential: (sub, service) => void delSvcCred.run(sub, service),
    getModuleSettings: (sub, module) =>
      (getModSettings.get(sub, module) as { data: string } | undefined)?.data,
    saveModuleSettings: (sub, module, data) => void putModSettings.run(sub, module, data),
    getPendingFlow: (sub) => getFlow.get(sub) as PendingLoginFlow | undefined,
    savePendingFlow: (f) => void putFlow.run(f.sub, f.pollToken, f.pollEndpoint),
    deletePendingFlow: (sub) => void delFlow.run(sub),
    saveSession: (tokenHash, sub, expiresAt) => void putSession.run(tokenHash, sub, expiresAt),
    getSessionSub: (tokenHash) => {
      delExpiredSessions.run();
      return (getSession.get(tokenHash) as { sub: string } | undefined)?.sub;
    },
    deleteSessionsForSub: (sub) => void delSessionsForSub.run(sub),
    listWikiPages: (sub) => listPages.all(sub) as Omit<WikiPageRow, "content" | "sub">[],
    getWikiPage: (sub, path) => getPage.get(sub, path) as WikiPageRow | undefined,
    wikiEtags: (sub) =>
      new Map(
        (pageEtags.all(sub) as { path: string; etag: string }[]).map((r) => [r.path, r.etag]),
      ),
    upsertWikiPage: (p) =>
      void putPage.run(p.sub, p.path, p.title, p.content, p.etag, p.mtime, p.syncedAt),
    pruneWikiPages: (sub, keepPaths) => pruneNotIn("wiki_pages", sub, keepPaths),
    searchWiki: (sub, query) =>
      searchPages.all(sub, `%${escapeLike(query)}%`, `%${escapeLike(query)}%`) as Pick<
        WikiPageRow,
        "path" | "title" | "content"
      >[],
    getWikiSyncedAt: (sub) => (getSync.get(sub) as { at: string } | undefined)?.at,
    setWikiSyncedAt: (sub, at) => void putSync.run(sub, at),
    listWikiChunks: (sub) => listChunks.all(sub) as WikiChunkRow[],
    wikiChunkEtags: (sub) =>
      new Map(
        (chunkEtags.all(sub) as { path: string; etag: string }[]).map((r) => [r.path, r.etag]),
      ),
    replaceWikiChunks: (sub, path, etag, chunks) => {
      db.exec("BEGIN");
      try {
        delChunksForPage.run(sub, path);
        for (const [i, c] of chunks.entries()) {
          putChunk.run(sub, path, i, c.text, c.embedding, etag);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    pruneWikiChunks: (sub, keepPaths) => pruneNotIn("wiki_chunks", sub, keepPaths),
    wikiChunkStats: (sub) =>
      (chunkStats.get(sub) as { chunks: number; pages: number } | undefined) ?? {
        chunks: 0,
        pages: 0,
      },
    listCsvFiles: (sub) => listCsv.all(sub) as (Omit<CsvFileRow, "sub"> & { rowCount: number })[],
    getCsvFile: (sub, id) => getCsv.get(sub, id) as Omit<CsvFileRow, "sub"> | undefined,
    createCsvFile: (sub, name, headers) => {
      const id = Number(putCsv.run(sub, name, JSON.stringify(headers)).lastInsertRowid);
      return getCsv.get(sub, id) as Omit<CsvFileRow, "sub">;
    },
    insertCsvRows: (fileId, rows) => {
      db.exec("BEGIN");
      try {
        for (const cells of rows) putCsvRow.run(fileId, JSON.stringify(cells), 0);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    listCsvRows: (fileId) => listRows.all(fileId) as CsvRowRow[],
    getCsvRow: (fileId, rowId) => getRow.get(fileId, rowId) as CsvRowRow | undefined,
    addCsvRow: (fileId, cells) =>
      Number(putCsvRow.run(fileId, JSON.stringify(cells), 0).lastInsertRowid),
    updateCsvRow: (fileId, rowId, patch) => {
      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (patch.cells !== undefined) {
        sets.push("cells = ?");
        args.push(JSON.stringify(patch.cells));
      }
      if (patch.done !== undefined) {
        sets.push("done = ?");
        args.push(patch.done ? 1 : 0);
      }
      if (sets.length === 0) return false;
      args.push(rowId, fileId);
      const res = db
        .prepare(`UPDATE csv_rows SET ${sets.join(", ")} WHERE id = ? AND file_id = ?`)
        .run(...args);
      return res.changes > 0;
    },
    deleteCsvRow: (fileId, rowId) => delCsvRow.run(fileId, rowId).changes > 0,
    deleteCsvFile: (sub, id) => {
      const res = delCsvFile.run(sub, id);
      if (res.changes > 0) delCsvRowsForFile.run(id);
      return res.changes > 0;
    },
    close: () => db.close(),
  };
}
