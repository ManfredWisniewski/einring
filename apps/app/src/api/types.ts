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
  | {
      status: "connected";
      loginName: string;
      displayName: string | null;
      server: string;
      /** Set only when an anonymous embedded flow completes — the einring session token. */
      sessionToken?: string;
    };

/** `flow` is set only for anonymous (embedded) starts; echo it back on poll. */
export interface LoginFlowStart {
  login: string;
  flow?: string;
}

export interface TableColumn {
  id: number;
  title: string;
  type: string;
  subtype?: string;
  options?: { id: number; label: string }[];
}

export interface TableRow {
  id: number;
  /** Raw cell values keyed by columnId — resolve labels via `TableColumn.options`. */
  cells: Record<string, unknown>;
}

export type TableNodeType = "view" | "table";

export interface TableNode {
  type: TableNodeType;
  id: number;
  title: string;
}

/** A Nextcloud Tables application (context) and its nodes (D40). */
export interface TablesApplication {
  name: string;
  nodes: TableNode[];
}

export interface TableView {
  kind: TableNodeType;
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
  /** Epoch ms of the user's last login; null when the account lacks admin access. */
  lastSeenAt: number | null;
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

export interface WikiLlmStatus {
  configured: boolean;
  indexing: boolean;
  pages: number;
  indexedPages: number;
  chunks: number;
}

export interface WikiIndexResult {
  pages: number;
  embeddedPages: number;
  chunks: number;
}

export interface WikiAskResult {
  answer: string;
  sources: { path: string; title: string }[];
}

export interface CsvFileMeta {
  id: number;
  name: string;
  headers: string[];
  rowCount: number;
  createdAt: string;
}

export interface CsvRow {
  id: number;
  cells: string[];
  done: boolean;
}

export interface CsvFile extends CsvFileMeta {
  rows: CsvRow[];
}

export interface TalkStatus {
  users: TalkUserStatus[];
  groups: string[];
  /** "all" = server admin, "partial" = group admin sees managed groups only, "none" = no group data. */
  groupsScope: "all" | "partial" | "none";
}

/** A client-held chat turn — the BFF is stateless, history re-sends each message (D41). */
export interface EinChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface EinChatStatus {
  configured: boolean;
  /** Tool names offered by enabled provider modules (e.g. yamtrack_search_media). */
  tools: string[];
}

export interface EinChatReply {
  reply: string;
}

/** A provider-module tool, with the user's enabled flag (EinChat data connections). */
export interface EinChatTool {
  name: string;
  /** Owning module id — the app groups and labels tools by it. */
  module: string;
  enabled: boolean;
}

export interface EinChatTools {
  tools: EinChatTool[];
}

/** Connector-module connection state (yamtrack, audiobookshelf, navidrome, trek). */
export interface ConnectorStatus {
  connected: boolean;
  /** Connected instance URL, or the deployment default when not yet connected. */
  url: string | null;
}
