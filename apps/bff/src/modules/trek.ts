import { z } from "zod";
import type { Fetch } from "../nextcloud/client.js";
import {
  apiKeySecret,
  type ConnectorOptions,
  connectorCred,
  connectorGet,
  registerConnectorRoutes,
} from "./connectors.js";
import type { BffModule, ChatTool } from "./types.js";

const configSchema = z.object({
  /** Default instance URL for the deployment; the connect form may override it. */
  URL: z.url().optional(),
});
type TrekConfig = z.infer<typeof configSchema>;

interface TrekTrip {
  id: number;
  title?: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  archived?: boolean;
}

function slimTrip(t: TrekTrip) {
  return {
    id: t.id,
    title: t.title ?? null,
    start_date: t.start_date ?? null,
    end_date: t.end_date ?? null,
    archived: t.archived === true,
  };
}

async function trekGet<T>(fetchImpl: Fetch, url: string, key: string, path: string) {
  return connectorGet<T>(fetchImpl, url, `/api/v1${path}`, { Authorization: `Bearer ${key}` });
}

const options = (config: TrekConfig): ConnectorOptions => ({
  service: "trek",
  defaultUrl: config.URL,
  parseSecret: apiKeySecret,
  verify: async (fetchImpl, url, key) => (await trekGet(fetchImpl, url, key, "/trips")).status,
});

export const trekModule: BffModule<TrekConfig> = {
  id: "trek",
  configSchema,

  chatTools(ctx): ChatTool[] {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const credFor = (sub: string) => connectorCred(ctx, sub, "trek");
    return [
      {
        name: "trek_list_trips",
        description:
          "List the user's trips in TREK (newest first): title, dates, archived flag. Use for questions about upcoming or past trips.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const res = await trekGet<{ trips?: TrekTrip[] }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "/trips",
          );
          if (!res.body) return { error: `trek returned ${res.status}` };
          return { trips: (res.body.trips ?? []).slice(0, 50).map(slimTrip) };
        },
      },
      {
        name: "trek_trip_details",
        description:
          "Get one TREK trip's itinerary: days, places in planned order, notes, reservations and accommodations. Needs the trip id from trek_list_trips.",
        parameters: {
          type: "object",
          properties: { id: { type: "number", description: "Trip id from trek_list_trips" } },
          required: ["id"],
        },
        async call(args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const id = typeof args.id === "number" ? args.id : Number(args.id);
          if (!Number.isInteger(id)) return { error: "id must be an integer" };
          const res = await trekGet<{
            trip?: TrekTrip & {
              days?: {
                date?: string;
                title?: string | null;
                notes?: string | null;
                places?: { name?: string; category?: string | null; time?: string | null }[];
              }[];
              reservations?: { title?: string; type?: string | null; date?: string | null }[];
            };
          }>(fetchImpl, cred.url, cred.secret, `/trips/${id}`);
          if (!res.body) return { error: `trek returned ${res.status}` };
          const t = res.body.trip;
          if (!t) return { error: `trek returned ${res.status}` };
          return {
            trip: {
              ...slimTrip(t),
              description: t.description ?? null,
              days: (t.days ?? []).map((d) => ({
                date: d.date ?? null,
                title: d.title ?? null,
                notes: d.notes ?? null,
                places: (d.places ?? []).map((p) => ({
                  name: p.name ?? null,
                  category: p.category ?? null,
                  time: p.time ?? null,
                })),
              })),
              reservations: (t.reservations ?? []).map((r) => ({
                title: r.title ?? null,
                type: r.type ?? null,
                date: r.date ?? null,
              })),
            },
          };
        },
      },
      {
        name: "trek_bucket_list",
        description:
          "List the user's TREK bucket list — places they want to visit, not tied to a trip.",
        parameters: { type: "object", properties: {} },
        async call(_args, sub) {
          const cred = credFor(sub);
          if (!cred) return { error: "not_connected" };
          const res = await trekGet<{ places?: { name?: string; country?: string | null }[] }>(
            fetchImpl,
            cred.url,
            cred.secret,
            "/bucket-list",
          );
          if (!res.body) return { error: `trek returned ${res.status}` };
          return {
            places: (res.body.places ?? [])
              .slice(0, 50)
              .map((p) => ({ name: p.name ?? null, country: p.country ?? null })),
          };
        },
      },
    ];
  },

  register(api, ctx, config) {
    registerConnectorRoutes(api, ctx, options(config));
  },
};
