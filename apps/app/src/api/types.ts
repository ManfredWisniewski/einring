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
  | { status: "connected"; loginName: string; server: string };

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
