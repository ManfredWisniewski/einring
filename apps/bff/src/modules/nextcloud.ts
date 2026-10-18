import { z } from "zod";
import type { AppContext } from "../app.js";
import type { BffModule } from "./types.js";

/**
 * Per-user Nextcloud feature toggles (D46): which Nextcloud-backed surfaces
 * this user wants. Stored as JSON in module_settings; all default true.
 * Preference-level switches — BFF routes keep working regardless.
 */
export interface NextcloudFeatures {
  monitorTalk: boolean;
  monitorServer: boolean;
  tables: boolean;
  wiki: boolean;
}

const FEATURE_KEYS = ["monitorTalk", "monitorServer", "tables", "wiki"] as const;

const putSchema = z
  .object({
    monitorTalk: z.boolean().optional(),
    monitorServer: z.boolean().optional(),
    tables: z.boolean().optional(),
    wiki: z.boolean().optional(),
  })
  .strict();

export function loadFeatures(ctx: AppContext, sub: string): NextcloudFeatures {
  const features: NextcloudFeatures = {
    monitorTalk: true,
    monitorServer: true,
    tables: true,
    wiki: true,
  };
  const raw = ctx.store.getModuleSettings(sub, "nextcloud");
  if (!raw) return features;
  try {
    const parsed = z.record(z.string(), z.boolean()).safeParse(JSON.parse(raw));
    if (!parsed.success) return features;
    for (const key of FEATURE_KEYS) {
      if (typeof parsed.data[key] === "boolean") features[key] = parsed.data[key];
    }
  } catch {
    // malformed stored JSON → defaults
  }
  return features;
}

export const nextcloudModule: BffModule = {
  id: "nextcloud",
  requires: ["nextcloud"],

  register(api, ctx) {
    api.get("/settings", async (req) => ({
      settings: loadFeatures(ctx, req.user.sub),
    }));

    api.put("/settings", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "expected a partial boolean feature map" });
      }
      const merged = { ...loadFeatures(ctx, req.user.sub), ...parsed.data };
      ctx.store.saveModuleSettings(req.user.sub, "nextcloud", JSON.stringify(merged));
      return { settings: merged };
    });
  },
};
