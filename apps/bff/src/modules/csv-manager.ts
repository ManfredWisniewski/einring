import { z } from "zod";
import type { CsvFileRow, CsvRowRow } from "../db.js";
import type { BffModule } from "./types.js";

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

export class CsvParseError extends Error {}

const CANDIDATE_DELIMITERS = [",", ";", "\t"] as const;

/** Most frequent delimiter on the first line (outside quotes); "," when undecided. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(CANDIDATE_DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "\n" || c === "\r") break;
    else if (!inQuotes && counts.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/**
 * RFC-4180-ish scanner: quoted fields with `""` escapes, delimiter and newlines
 * inside quotes, CRLF/LF/CR line ends, BOM skip, lenient mid-field quotes.
 * Throws CsvParseError on unbalanced quotes.
 */
export function scanCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    field += c;
  }
  if (inQuotes) throw new CsvParseError("unbalanced quotes in csv");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** First record = headers (trimmed); blank records are dropped; rows are padded to header width. */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const records = scanCsv(text, detectDelimiter(text)).filter((r) => r.some((c) => c !== ""));
  const headers = (records[0] ?? []).map((h) => h.trim());
  if (headers.length === 0 || headers.every((h) => h === "")) {
    throw new CsvParseError("csv has no header row");
  }
  const width = headers.length;
  const rows = records.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
  return { headers, rows };
}

const configSchema = z.object({
  /** Max request body for a single import (bytes). */
  MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  /** Max data rows accepted per import. */
  MAX_ROWS: z.coerce.number().int().positive().default(20000),
});

const cells = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.map((c) => (c == null ? "" : String(c))) : null;

const pad = (cells: string[], width: number): string[] =>
  Array.from({ length: width }, (_, i) => cells[i] ?? "");

export const csvManagerModule: BffModule<z.infer<typeof configSchema>> = {
  id: "csv-manager",
  configSchema,
  register(api, ctx, config) {
    const { store } = ctx;

    const toMeta = (f: Omit<CsvFileRow, "sub"> & { rowCount?: number }): CsvFileMeta => ({
      id: f.id,
      name: f.name,
      headers: JSON.parse(f.headers) as string[],
      rowCount: f.rowCount ?? 0,
      createdAt: f.createdAt,
    });
    const toRow = (r: CsvRowRow): CsvRow => ({
      id: r.id,
      cells: JSON.parse(r.cells) as string[],
      done: r.done !== 0,
    });
    const fileId = (p: unknown) => Number((p as { fileId?: string }).fileId);
    const rowId = (p: unknown) => Number((p as { rowId?: string }).rowId);

    api.get("/files", async (request) => ({
      files: store.listCsvFiles(request.user.sub).map(toMeta),
    }));

    api.post("/files", { bodyLimit: config.MAX_BYTES }, async (request, reply) => {
      const body = request.body as { name?: unknown; csv?: unknown } | null | undefined;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      const csv = typeof body?.csv === "string" ? body.csv : "";
      if (!name || !csv) {
        return reply.code(400).send({ error: "name and csv are required" });
      }
      let parsed: ReturnType<typeof parseCsv>;
      try {
        parsed = parseCsv(csv);
      } catch (err) {
        const msg = err instanceof CsvParseError ? err.message : "invalid csv";
        return reply.code(400).send({ error: msg });
      }
      if (parsed.rows.length > config.MAX_ROWS) {
        return reply.code(413).send({ error: `csv exceeds ${config.MAX_ROWS} rows` });
      }
      const file = store.createCsvFile(request.user.sub, name, parsed.headers);
      if (parsed.rows.length > 0) store.insertCsvRows(file.id, parsed.rows);
      return reply.code(201).send(toMeta({ ...file, rowCount: parsed.rows.length }));
    });

    api.get("/files/:fileId", async (request, reply) => {
      const file = store.getCsvFile(request.user.sub, fileId(request.params));
      if (!file) return reply.code(404).send({ error: "file not found" });
      return { ...toMeta(file), rows: store.listCsvRows(file.id).map(toRow) } satisfies CsvFile;
    });

    api.delete("/files/:fileId", async (request, reply) => {
      if (!store.deleteCsvFile(request.user.sub, fileId(request.params))) {
        return reply.code(404).send({ error: "file not found" });
      }
      return reply.code(204).send();
    });

    api.post("/files/:fileId/rows", async (request, reply) => {
      const file = store.getCsvFile(request.user.sub, fileId(request.params));
      if (!file) return reply.code(404).send({ error: "file not found" });
      const width = (JSON.parse(file.headers) as string[]).length;
      const body = request.body as { cells?: unknown } | null | undefined;
      const given = body?.cells === undefined ? [] : cells(body.cells);
      if (given === null) return reply.code(400).send({ error: "cells must be an array" });
      const row = pad(given, width);
      const id = store.addCsvRow(file.id, row);
      return reply.code(201).send({ id, cells: row, done: false } satisfies CsvRow);
    });

    api.patch("/files/:fileId/rows/:rowId", async (request, reply) => {
      const file = store.getCsvFile(request.user.sub, fileId(request.params));
      if (!file) return reply.code(404).send({ error: "file not found" });
      const body = request.body as { cells?: unknown; done?: unknown } | null | undefined;
      const patch: { cells?: string[]; done?: boolean } = {};
      if (body && "cells" in body) {
        const given = cells(body.cells);
        if (given === null) return reply.code(400).send({ error: "cells must be an array" });
        patch.cells = pad(given, (JSON.parse(file.headers) as string[]).length);
      }
      if (body && "done" in body) {
        if (typeof body.done !== "boolean") {
          return reply.code(400).send({ error: "done must be a boolean" });
        }
        patch.done = body.done;
      }
      if (patch.cells === undefined && patch.done === undefined) {
        return reply.code(400).send({ error: "nothing to update" });
      }
      if (!store.updateCsvRow(file.id, rowId(request.params), patch)) {
        return reply.code(404).send({ error: "row not found" });
      }
      const row = store.getCsvRow(file.id, rowId(request.params));
      if (!row) return reply.code(404).send({ error: "row not found" });
      return toRow(row);
    });

    api.delete("/files/:fileId/rows/:rowId", async (request, reply) => {
      const file = store.getCsvFile(request.user.sub, fileId(request.params));
      if (!file) return reply.code(404).send({ error: "file not found" });
      if (!store.deleteCsvRow(file.id, rowId(request.params))) {
        return reply.code(404).send({ error: "row not found" });
      }
      return reply.code(204).send();
    });
  },
};
