import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { Store, TimeEntryPatch, TimeEntryRow } from "../db.js";
import { listMapped, timeProviders } from "./eintime/providers.js";
import { type DaySegment, segmentEntries } from "./eintime/segment.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Week-grid paint snap in minutes (edge resize always allows 1-minute precision). */
  SNAP_MINUTES: z.coerce.number().int().min(1).max(60).optional().default(15),
});
type EintimeConfig = z.infer<typeof configSchema>;

const ORIGINS = new Set(["manual", "itsaplan"]);

const isIso = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));

const asStr = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "string" ? v : undefined;
};

const strOr = (v: unknown, fallback: string): string =>
  typeof v === "string" && v.length > 0 ? v : fallback;

/** One entry as the API serves it — billable as boolean, tags as names. */
function apiEntry(row: TimeEntryRow, tags: string[]) {
  return {
    id: row.id,
    start: row.start,
    end: row.end,
    description: row.description,
    provider: row.provider,
    projectExternalId: row.projectExternalId,
    taskExternalId: row.taskExternalId,
    clientName: row.clientName,
    projectName: row.projectName,
    taskName: row.taskName,
    billable: row.billable === 1,
    origin: row.origin,
    running: row.end === null,
    tags,
  };
}

function apiSegment(seg: DaySegment<TimeEntryRow>, tags: string[]) {
  return {
    ...apiEntry(seg.entry, tags),
    entryId: seg.entryId,
    day: seg.day,
    segStart: seg.segStart,
    segEnd: seg.segEnd,
  };
}

function tagNames(store: Store, rows: TimeEntryRow[]): Map<string, string[]> {
  return store.timeEntryTagNames(rows.map((r) => r.id));
}

/**
 * Validated mapping/name/tag fields shared by timer start, entry create and patch.
 * Returns a patch object or an error message.
 */
function mappingFields(body: Record<string, unknown>): TimeEntryPatch | string {
  const patch: TimeEntryPatch = {};
  for (const [key, field] of [
    ["provider", "provider"],
    ["projectExternalId", "projectExternalId"],
    ["taskExternalId", "taskExternalId"],
    ["clientName", "clientName"],
    ["projectName", "projectName"],
    ["taskName", "taskName"],
  ] as const) {
    const v = asStr(body[key]);
    if (v === undefined && body[key] !== undefined) return `${key} must be a string or null`;
    if (v !== undefined) (patch as Record<string, unknown>)[field] = v;
  }
  if (body.billable !== undefined) {
    if (typeof body.billable !== "boolean") return "billable must be a boolean";
    patch.billable = body.billable ? 1 : 0;
  }
  if (body.description !== undefined) {
    const d = asStr(body.description);
    if (d === undefined || d === null) return "description must be a string";
    patch.description = d;
  }
  return patch;
}

/** Upsert tag names for the user and link them to an entry (replace). */
function setEntryTags(store: Store, sub: string, entryId: string, tags: unknown): string | null {
  if (tags === undefined) return null;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || t.trim() === ""))
    return "tags must be an array of non-empty strings";
  const ids = (tags as string[]).map(
    (name) => store.ensureTimeTag(sub, randomUUID(), name.trim()).id,
  );
  store.setTimeEntryTags(entryId, ids);
  return null;
}

interface ReportArgs {
  from?: string;
  to?: string;
  groupBy: "project" | "task" | "client";
  client?: string;
  project?: string;
  task?: string;
  tag?: string;
  billable?: boolean;
}

function computeReport(ctx: AppContext, sub: string, memberName: string | null, args: ReportArgs) {
  const rows = ctx.store.listTimeEntries(sub, args.from, args.to);
  const tags = tagNames(ctx.store, rows);
  const now = Date.now();
  const matches = (v: string | null | undefined, keys: (string | null)[]) =>
    v === undefined || keys.some((k) => k !== null && k === v);
  const filtered = rows.filter((r) => {
    if (!matches(args.client, [r.clientName])) return false;
    if (!matches(args.project, [r.projectExternalId, r.projectName])) return false;
    if (!matches(args.task, [r.taskExternalId, r.taskName])) return false;
    if (args.tag !== undefined && !(tags.get(r.id) ?? []).includes(args.tag)) return false;
    if (args.billable !== undefined && (r.billable === 1) !== args.billable) return false;
    return true;
  });
  const minutes = (r: TimeEntryRow) =>
    Math.max(0, Math.round(((r.end ? Date.parse(r.end) : now) - Date.parse(r.start)) / 60_000));
  const groupKey = (r: TimeEntryRow) => {
    if (args.groupBy === "task") return r.taskExternalId ?? r.taskName ?? "";
    if (args.groupBy === "client") return r.clientName ?? "";
    return r.projectExternalId ?? r.projectName ?? "";
  };
  const groupName = (r: TimeEntryRow) => {
    if (args.groupBy === "task") return r.taskName;
    if (args.groupBy === "client") return r.clientName;
    return r.projectName;
  };
  const groups = new Map<
    string,
    { key: string; name: string | null; minutes: number; entryCount: number }
  >();
  for (const r of filtered) {
    const key = groupKey(r);
    const g = groups.get(key) ?? { key, name: groupName(r), minutes: 0, entryCount: 0 };
    g.minutes += minutes(r);
    g.entryCount += 1;
    groups.set(key, g);
  }
  return {
    range: { from: args.from ?? null, to: args.to ?? null },
    member: { sub, name: memberName },
    groupBy: args.groupBy,
    groups: [...groups.values()].sort((a, b) => b.minutes - a.minutes),
    totalMinutes: filtered.reduce((s, r) => s + minutes(r), 0),
    entries: filtered.map((r) => ({
      ...apiEntry(r, tags.get(r.id) ?? []),
      minutes: minutes(r),
      member: sub,
    })),
  };
}

export const eintimeModule: BffModule<EintimeConfig> = {
  id: "eintime",
  version: "0.1.0",
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "eintime_entries",
        description:
          "List the caller's EinTime time entries for a date range (ISO `from`/`to`, " +
          "newest first) — description, project/task/client names, tags, billable, start/stop.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Range start (ISO, optional)" },
            to: { type: "string", description: "Range end (ISO, optional)" },
            limit: { type: "number", description: "Max entries (default 20, max 100)" },
          },
        },
        async call(args, sub) {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
          const from = isIso(args.from) ? args.from : undefined;
          const to = isIso(args.to) ? args.to : undefined;
          const rows = ctx.store.listTimeEntries(sub, from, to).slice(0, limit);
          const tags = tagNames(ctx.store, rows);
          return { entries: rows.map((r) => apiEntry(r, tags.get(r.id) ?? [])) };
        },
      },
      {
        name: "eintime_projects",
        description:
          "List the clients, projects and tasks eintime's provider mapping resolves " +
          "(itsaplan teams/boards/assigned tickets) — the values entries can be filed under.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const mapped = await listMapped(ctx, sub);
          return { providers: timeProviders.map((p) => p.id), ...mapped };
        },
      },
      {
        name: "eintime_report",
        description:
          "Run an EinTime report for a date range: grouped totals plus the matching " +
          "entry rows. Filters: client, project, task, tag, billable.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Range start (ISO, optional)" },
            to: { type: "string", description: "Range end (ISO, optional)" },
            groupBy: {
              type: "string",
              enum: ["project", "task", "client"],
              description: "Grouping dimension (default project)",
            },
            client: { type: "string" },
            project: { type: "string" },
            task: { type: "string" },
            tag: { type: "string" },
            billable: { type: "boolean" },
          },
        },
        async call(args, sub, user) {
          return computeReport(ctx, sub, user?.name ?? null, reportArgs(args));
        },
      },
    ];
  },

  register(api, ctx, _config) {
    const store = ctx.store;
    const load = (sub: string, id: string) => store.getTimeEntry(sub, id);

    api.get("/timer", async (req) => {
      const row = store.getRunningTimeEntry(req.user.sub);
      return { running: row ? apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) : null };
    });

    api.post("/timer", async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fields = mappingFields(body);
      if (typeof fields === "string") return reply.code(400).send({ error: fields });
      const now = new Date().toISOString();
      const running = store.getRunningTimeEntry(req.user.sub);
      if (running) store.updateTimeEntry(req.user.sub, running.id, { end: now });
      const row = store.createTimeEntry({
        id: randomUUID(),
        sub: req.user.sub,
        start: now,
        end: null,
        description: strOr(fields.description, ""),
        provider: fields.provider ?? null,
        projectExternalId: fields.projectExternalId ?? null,
        taskExternalId: fields.taskExternalId ?? null,
        clientName: fields.clientName ?? null,
        projectName: fields.projectName ?? null,
        taskName: fields.taskName ?? null,
        billable: fields.billable ?? 0,
        origin: "manual",
      });
      const tagErr = setEntryTags(store, req.user.sub, row.id, body.tags);
      if (tagErr) return reply.code(400).send({ error: tagErr });
      return { running: apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) };
    });

    api.patch("/timer", async (req, reply) => {
      const running = store.getRunningTimeEntry(req.user.sub);
      if (!running) return reply.code(404).send({ error: "no running entry" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fields = mappingFields(body);
      if (typeof fields === "string") return reply.code(400).send({ error: fields });
      if (body.start !== undefined) {
        if (!isIso(body.start) || Date.parse(body.start) > Date.now())
          return reply.code(400).send({ error: "start must be an ISO instant not in the future" });
        fields.start = body.start;
      }
      const tagErr = setEntryTags(store, req.user.sub, running.id, body.tags);
      if (tagErr) return reply.code(400).send({ error: tagErr });
      const row = store.updateTimeEntry(req.user.sub, running.id, fields);
      return { running: row ? apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) : null };
    });

    api.post("/timer/stop", async (req, reply) => {
      const running = store.getRunningTimeEntry(req.user.sub);
      if (!running) return reply.code(404).send({ error: "no running entry" });
      const row = store.updateTimeEntry(req.user.sub, running.id, {
        end: new Date().toISOString(),
      });
      return { entry: row ? apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) : null };
    });

    api.get("/entries", async (req) => {
      const q = req.query as { from?: string; to?: string; tzOffset?: string };
      const from = isIso(q.from) ? q.from : undefined;
      const to = isIso(q.to) ? q.to : undefined;
      const tzOffset = Math.max(-840, Math.min(840, Number(q.tzOffset) || 0));
      const rows = store.listTimeEntries(req.user.sub, from, to);
      const tags = tagNames(store, rows);
      const segments = segmentEntries(rows, new Date(), tzOffset);
      return {
        entries: segments.map((s) => apiSegment(s, tags.get(s.entryId) ?? [])),
      };
    });

    api.post("/entries", async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isIso(body.start))
        return reply.code(400).send({ error: "start must be an ISO instant" });
      let end: string | null = null;
      if (body.end !== undefined && body.end !== null) {
        if (!isIso(body.end)) return reply.code(400).send({ error: "end must be an ISO instant" });
        end = body.end;
      } else if (body.durationMinutes !== undefined) {
        const d = Number(body.durationMinutes);
        if (!Number.isFinite(d) || d <= 0)
          return reply.code(400).send({ error: "durationMinutes must be a positive number" });
        end = new Date(Date.parse(body.start) + Math.round(d * 60_000)).toISOString();
      } else {
        return reply.code(400).send({ error: "end or durationMinutes is required" });
      }
      if (end !== null && Date.parse(end) < Date.parse(body.start))
        return reply.code(400).send({ error: "end must not be before start" });
      const fields = mappingFields(body);
      if (typeof fields === "string") return reply.code(400).send({ error: fields });
      if (body.origin !== undefined && !ORIGINS.has(String(body.origin)))
        return reply.code(400).send({ error: "bad origin" });
      const row = store.createTimeEntry({
        id: randomUUID(),
        sub: req.user.sub,
        start: body.start,
        end,
        description: strOr(fields.description, ""),
        provider: fields.provider ?? null,
        projectExternalId: fields.projectExternalId ?? null,
        taskExternalId: fields.taskExternalId ?? null,
        clientName: fields.clientName ?? null,
        projectName: fields.projectName ?? null,
        taskName: fields.taskName ?? null,
        billable: fields.billable ?? 0,
        origin: ORIGINS.has(String(body.origin)) ? String(body.origin) : "manual",
      });
      const tagErr = setEntryTags(store, req.user.sub, row.id, body.tags);
      if (tagErr) return reply.code(400).send({ error: tagErr });
      return reply
        .code(201)
        .send({ entry: apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) });
    });

    api.patch("/entries/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const existing = load(req.user.sub, id);
      if (!existing) return reply.code(404).send({ error: "entry not found" });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const fields = mappingFields(body);
      if (typeof fields === "string") return reply.code(400).send({ error: fields });
      if (body.start !== undefined) {
        if (!isIso(body.start))
          return reply.code(400).send({ error: "start must be an ISO instant" });
        if (existing.end === null && Date.parse(body.start) > Date.now())
          return reply.code(400).send({ error: "running start must not be in the future" });
        fields.start = body.start;
      }
      if (body.end !== undefined) {
        if (!isIso(body.end)) return reply.code(400).send({ error: "end must be an ISO instant" });
        fields.end = body.end;
      }
      const newStart = fields.start ?? existing.start;
      const newEnd = fields.end ?? existing.end;
      if (newEnd !== null && Date.parse(newEnd) < Date.parse(newStart))
        return reply.code(400).send({ error: "end must not be before start" });
      const tagErr = setEntryTags(store, req.user.sub, id, body.tags);
      if (tagErr) return reply.code(400).send({ error: tagErr });
      const row = store.updateTimeEntry(req.user.sub, id, fields);
      return { entry: row ? apiEntry(row, tagNames(store, [row]).get(row.id) ?? []) : null };
    });

    api.delete("/entries/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!store.deleteTimeEntry(req.user.sub, id))
        return reply.code(404).send({ error: "entry not found" });
      return reply.code(204).send();
    });

    api.get("/projects", async (req) => {
      const mapped = await listMapped(ctx, req.user.sub);
      return { providers: timeProviders.map((p) => p.id), ...mapped };
    });

    api.get("/tags", async (req) => ({
      tags: store.listTimeTags(req.user.sub).map((t) => ({ id: t.id, name: t.name })),
    }));

    api.post("/tags", async (req, reply) => {
      const name = (req.body as { name?: unknown })?.name;
      if (typeof name !== "string" || name.trim() === "")
        return reply.code(400).send({ error: "name is required" });
      const tag = store.ensureTimeTag(req.user.sub, randomUUID(), name.trim());
      return reply.code(201).send({ tag: { id: tag.id, name: tag.name } });
    });

    api.get("/report", async (req) => {
      return computeReport(
        ctx,
        req.user.sub,
        req.user.name ?? null,
        reportArgs(req.query as Record<string, unknown>),
      );
    });
  },
};

const GROUPS = new Set(["project", "task", "client"]);

function reportArgs(q: Record<string, unknown>): ReportArgs {
  return {
    from: isIso(q.from) ? q.from : undefined,
    to: isIso(q.to) ? q.to : undefined,
    groupBy: GROUPS.has(String(q.groupBy)) ? (q.groupBy as ReportArgs["groupBy"]) : "project",
    client: asStr(q.client) ?? undefined,
    project: asStr(q.project) ?? undefined,
    task: asStr(q.task) ?? undefined,
    tag: asStr(q.tag) ?? undefined,
    billable:
      q.billable === "true" || q.billable === true
        ? true
        : q.billable === "false" || q.billable === false
          ? false
          : undefined,
  };
}
