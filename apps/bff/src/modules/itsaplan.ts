import { z } from "zod";
import type { AppContext } from "../app.js";
import {
  apiKeySecret,
  type ConnectorOptions,
  connectorCred,
  connectorGet,
  connectorUrlSchema,
  normalizeBase,
  registerConnectorRoutes,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default API base URL of the itsaplan instance (WIT deployment: https://plan.w1t.org/api). */
  URL: z.url().optional(),
});
type ItsaplanConfig = z.infer<typeof configSchema>;

export interface ItsaplanBoard {
  id: number;
  key: string;
  ref: string;
  name: string;
  teamName: string;
  teamRef: string;
  url: string | null;
  archived: boolean;
  lastActivityAt: string | null;
  timeEstimateEnabled: boolean;
}

export interface ItsaplanColumn {
  id: number;
  name: string;
  stateType: string | null;
  color: string | null;
}

export interface ItsaplanTicket {
  id: number;
  identifier: string;
  title: string;
  projectKey: string;
  projectRef: string;
  projectName: string;
  teamName: string;
  columnId: number;
  column: string | null;
  stateType: string | null;
  priority: string | null;
  dueDate: string | null;
  url: string | null;
  updatedAt: string;
  estimateMinutes: number | null;
}

interface ItsaplanMe {
  authenticated: boolean;
  user?: { id: string };
}

interface ItsaplanProjectRaw {
  id: number;
  teamRef: string;
  key: string;
  ref: string;
  name: string;
  teamName: string;
  archivedAt: string | null;
  lastActivityAt?: string | null;
  timeEstimateEnabled?: boolean;
}

interface ItsaplanProjectBoardRaw {
  columns?: { id: number; name: string; stateType?: string; color?: string }[];
}

interface ItsaplanIssueRaw {
  id: number;
  identifier: string;
  title: string;
  columnId: number;
  priority: string | null;
  dueDate: string | null;
  updatedAt: string;
  estimateMinutes?: number | null;
  projectId: number;
  projectRef: string;
  projectKey: string;
  projectName: string;
  teamName: string;
}

type ColumnMap = Map<number, { name: string; stateType: string | null }>;

/** The connector URL is the API base; a bare host gets `/api` appended. */
function parseItsaplanUrl(raw: unknown): string | null {
  const parsed = connectorUrlSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const u = new URL(parsed.data);
    u.pathname = u.pathname.replace(/\/+$/, "") || "/api";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Web-app base for board/ticket links: the API base minus a trailing `/api`. */
function webBase(apiBase: string): string {
  return normalizeBase(apiBase).replace(/\/api$/, "");
}

function credFor(ctx: AppContext, sub: string) {
  return connectorCred(ctx, sub, "itsaplan");
}

async function itsaplanGet<T>(
  ctx: AppContext,
  url: string,
  key: string,
  path: string,
): Promise<{ status: number; body: T | null }> {
  return connectorGet<T>(ctx.fetchImpl ?? fetch, url, path, { "x-api-key": key });
}

async function itsaplanPatch<T>(
  ctx: AppContext,
  url: string,
  key: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: T | null }> {
  const res = await (ctx.fetchImpl ?? fetch)(`${normalizeBase(url)}${path}`, {
    method: "PATCH",
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { status: res.status, body: null };
  return { status: res.status, body: (await res.json()) as T };
}

function mapBoard(p: ItsaplanProjectRaw, web: string): ItsaplanBoard {
  return {
    id: p.id,
    key: p.key,
    ref: p.ref,
    name: p.name,
    teamName: p.teamName,
    teamRef: p.teamRef,
    url: `${web}/${p.teamRef}/${p.key}/`,
    archived: p.archivedAt != null,
    lastActivityAt: p.lastActivityAt ?? null,
    timeEstimateEnabled: p.timeEstimateEnabled === true,
  };
}

function mapTicket(i: ItsaplanIssueRaw, web: string, cols?: ColumnMap): ItsaplanTicket {
  const col = cols?.get(i.columnId);
  // projectRef is '<teamRef>.<key>'; team slugs are [a-z0-9-] — no dots to guard.
  const teamRef = i.projectRef.replace(/\.[^.]+$/, "");
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    projectKey: i.projectKey,
    projectRef: i.projectRef,
    projectName: i.projectName,
    teamName: i.teamName,
    columnId: i.columnId,
    column: col?.name ?? null,
    stateType: col?.stateType ?? null,
    priority: i.priority ?? null,
    dueDate: i.dueDate ?? null,
    url: `${web}/${teamRef}/issue/${encodeURIComponent(i.identifier)}`,
    updatedAt: i.updatedAt ?? "",
    estimateMinutes: i.estimateMinutes ?? null,
  };
}

async function listBoards(ctx: AppContext, sub: string) {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true as const };
  const res = await itsaplanGet<ItsaplanProjectRaw[]>(ctx, cred.url, cred.secret, "/projects");
  if (res.status === 401 || res.status === 403) return { rejected: true as const };
  if (!res.body) return { failed: res.status };
  const web = webBase(cred.url);
  return { boards: res.body.map((p) => mapBoard(p, web)) };
}

async function listTickets(ctx: AppContext, sub: string, limit: number) {
  const cred = credFor(ctx, sub);
  if (!cred) return { notConnected: true as const };
  const me = await itsaplanGet<ItsaplanMe>(ctx, cred.url, cred.secret, "/me");
  if (me.status === 401 || me.status === 403) return { rejected: true as const };
  // A revoked/expired key answers 200 {authenticated:false} — that is auth loss, not a failure.
  if (me.body?.authenticated === false) return { rejected: true as const };
  if (!me.body?.user?.id) return { failed: me.status };
  const res = await itsaplanGet<ItsaplanIssueRaw[]>(
    ctx,
    cred.url,
    cred.secret,
    `/issues?assigneeUserId=${encodeURIComponent(me.body.user.id)}` +
      `&stateTypes=backlog,unstarted,started&limit=${limit}`,
  );
  if (res.status === 401 || res.status === 403) return { rejected: true as const };
  if (!res.body) return { failed: res.status };
  // Resolve column names per project; a failed lookup degrades to null state, not an error.
  const refs = [...new Set(res.body.map((i) => i.projectRef))];
  const columnMaps = new Map<string, ColumnMap>();
  const columns: Record<string, ItsaplanColumn[]> = {};
  await Promise.all(
    refs.map(async (ref) => {
      const board = await itsaplanGet<ItsaplanProjectBoardRaw>(
        ctx,
        cred.url,
        cred.secret,
        `/projects/${encodeURIComponent(ref)}`,
      );
      const map: ColumnMap = new Map();
      const list: ItsaplanColumn[] = [];
      for (const c of board.body?.columns ?? []) {
        map.set(c.id, { name: c.name, stateType: c.stateType ?? null });
        list.push({
          id: c.id,
          name: c.name,
          stateType: c.stateType ?? null,
          color: c.color ?? null,
        });
      }
      columnMaps.set(ref, map);
      columns[ref] = list;
    }),
  );
  const web = webBase(cred.url);
  return {
    tickets: res.body.map((i) => mapTicket(i, web, columnMaps.get(i.projectRef))),
    columns,
  };
}

function resultError(res: { failed?: number }) {
  return { error: `itsaplan returned ${res.failed}` };
}

export const itsaplanModule: BffModule<ItsaplanConfig> = {
  id: "itsaplan",
  version: "0.1.0",
  configSchema,

  notifications(ctx) {
    return {
      // Assigned open tickets → einhub items; dedupe by issue id (D42).
      async poll(sub) {
        const res = await listTickets(ctx, sub, 10);
        if (!("tickets" in res) || !res.tickets) return [];
        return res.tickets.map((t) => ({
          sourceId: String(t.id),
          title: `${t.identifier}: ${t.title}`,
          body: [t.projectName, t.teamName].filter(Boolean).join(" · ") || undefined,
          at: t.updatedAt || undefined,
        }));
      },
    };
  },

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "itsaplan_boards",
        description:
          "List the itsaplan boards (projects) the user is a member of — key, name, team, web link.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const res = await listBoards(ctx, sub);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("rejected" in res) return { error: "itsaplan rejected the api key" };
          if ("failed" in res) return resultError(res);
          return { boards: res.boards };
        },
      },
      {
        name: "itsaplan_tickets",
        description:
          "List the open itsaplan tickets currently assigned to the user across all boards " +
          "(identifier, title, board, column, priority, due date, web link).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max tickets to return (default 10, max 50)" },
          },
        },
        async call(args, sub) {
          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
          const res = await listTickets(ctx, sub, limit);
          if ("notConnected" in res) return { error: "not_connected" };
          if ("rejected" in res) return { error: "itsaplan rejected the api key" };
          if ("failed" in res) return resultError(res);
          return { tickets: res.tickets };
        },
      },
    ];
  },

  register(api, ctx, config) {
    const options: ConnectorOptions = {
      service: "itsaplan",
      defaultUrl: config.URL,
      parseSecret: apiKeySecret,
      parseUrl: parseItsaplanUrl,
      verify: async (fetchImpl, url, key) => {
        // GET /me answers 200 with {authenticated:false} for a bad key — check the body.
        const res = await fetchImpl(`${normalizeBase(url)}/me`, {
          headers: { Accept: "application/json", "x-api-key": key },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return res.status;
        const body = (await res.json()) as { authenticated?: boolean };
        return body?.authenticated === true ? 200 : 401;
      },
    };
    registerConnectorRoutes(api, ctx, options);

    api.get("/boards", async (req, reply) => {
      const res = await listBoards(ctx, req.user.sub);
      if ("notConnected" in res) return reply.code(424).send({ error: "not connected" });
      if ("rejected" in res)
        return reply.code(401).send({ error: "itsaplan rejected the api key" });
      if ("failed" in res)
        return reply.code(502).send({ error: `itsaplan unreachable (${res.failed})` });
      return { boards: res.boards };
    });

    api.get("/tickets", async (req, reply) => {
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string }).limit) || 200, 1),
        500,
      );
      const res = await listTickets(ctx, req.user.sub, limit);
      if ("notConnected" in res) return reply.code(424).send({ error: "not connected" });
      if ("rejected" in res)
        return reply.code(401).send({ error: "itsaplan rejected the api key" });
      if ("failed" in res)
        return reply.code(502).send({ error: `itsaplan unreachable (${res.failed})` });
      return { tickets: res.tickets, columns: res.columns };
    });

    api.patch("/tickets/:issueId", async (req, reply) => {
      const cred = credFor(ctx, req.user.sub);
      if (!cred) return reply.code(424).send({ error: "not connected" });
      const issueId = Number((req.params as { issueId: string }).issueId);
      if (!Number.isInteger(issueId) || issueId <= 0)
        return reply.code(400).send({ error: "bad issue id" });
      const input = (req.body ?? {}) as { estimateMinutes?: unknown; columnId?: unknown };
      const patch: { estimateMinutes?: number; columnId?: number } = {};
      if (input.estimateMinutes !== undefined) {
        const m = Number(input.estimateMinutes);
        if (!Number.isInteger(m) || m < 0)
          return reply.code(400).send({ error: "estimateMinutes must be a non-negative integer" });
        patch.estimateMinutes = m;
      }
      if (input.columnId !== undefined) {
        const cid = Number(input.columnId);
        if (!Number.isInteger(cid) || cid <= 0)
          return reply.code(400).send({ error: "columnId must be a positive integer" });
        patch.columnId = cid;
      }
      if (patch.estimateMinutes === undefined && patch.columnId === undefined)
        return reply.code(400).send({ error: "nothing to update" });
      const res = await itsaplanPatch<ItsaplanIssueRaw>(
        ctx,
        cred.url,
        cred.secret,
        `/issues/${issueId}`,
        patch,
      );
      if (res.status === 401 || res.status === 403)
        return reply.code(401).send({ error: "itsaplan rejected the api key" });
      if (res.status === 404) return reply.code(404).send({ error: "ticket not found" });
      if (res.status === 409) return reply.code(409).send({ error: "wip_limit_exceeded" });
      if (!res.body) return reply.code(502).send({ error: `itsaplan unreachable (${res.status})` });
      return {
        columnId: res.body.columnId ?? null,
        estimateMinutes: res.body.estimateMinutes ?? null,
      };
    });
  },
};
