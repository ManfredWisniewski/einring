// Mirrors the BFF response shapes (apps/bff/src/routes). Keep in sync until shared types are extracted.

export interface Me {
  sub: string;
  name?: string;
  email?: string;
  preferredUsername?: string;
}

export type ConnectionStatus =
  | { status: "disconnected" }
  | { status: "pending"; login: string }
  | { status: "connected"; loginName: string; displayName: string | null; server: string };

export interface TableColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
}

export interface TableRow {
  id: number;
  cells: Record<string, unknown>;
}

export interface TableView {
  id: number;
  title: string;
  emoji?: string;
  columns: TableColumn[];
  rows: TableRow[];
}

/** A module enabled on the BFF; `requires` lists the services it consumes. */
export interface ModuleInfo {
  id: string;
  requires: string[];
}

export interface ModuleRegistry {
  modules: ModuleInfo[];
}

export interface ServerHealth {
  version: string | null;
  webserver: string | null;
  phpVersion: string | null;
  database: { type: string | null; version: string | null; sizeBytes: number | null } | null;
  cpuLoad: number[] | null;
  memory: { totalBytes: number; freeBytes: number } | null;
  swap: { totalBytes: number; freeBytes: number } | null;
  freeSpaceBytes: number | null;
  users: {
    total: number | null;
    last5min: number | null;
    last1h: number | null;
    last24h: number | null;
  };
  apps: { installed: number | null; updatesAvailable: number | null };
}

export interface ServerBasics {
  product: string | null;
  version: string | null;
  quota: { usedBytes: number; freeBytes: number; totalBytes: number | null } | null;
  apps: { talk: string | null; userStatus: boolean; collectives: boolean; tables: boolean };
}

export interface ServerHealthResponse {
  available: boolean;
  health: ServerHealth | null;
  basics: ServerBasics | null;
}

export interface TalkUserStatus {
  userId: string;
  displayName: string | null;
  status: string;
  message: string | null;
  icon: string | null;
  groups: string[];
}

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

export interface TalkStatus {
  users: TalkUserStatus[];
  groups: string[];
  /** "all" = server admin, "partial" = group admin sees managed groups only, "none" = no group data. */
  groupsScope: "all" | "partial" | "none";
}
