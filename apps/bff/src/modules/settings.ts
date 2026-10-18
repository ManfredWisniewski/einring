import { z } from "zod";
import type { AppContext } from "../app.js";
import type { BffModule } from "./types.js";

/** einhub is the index route — disabling it would strand `/`. */
const LOCKED = new Set(["einhub"]);

const putSchema = z.object({ disabled: z.array(z.string()) });

function knownIds(ctx: AppContext): Set<string> {
  return new Set(ctx.modules.map(({ module }) => module.id));
}

export function disabledModules(ctx: AppContext, sub: string): Set<string> {
  const raw = ctx.store.getModuleSettings(sub, "settings");
  if (!raw) return new Set();
  try {
    const parsed = putSchema.shape.disabled.safeParse(
      (JSON.parse(raw) as { disabled?: unknown }).disabled,
    );
    return new Set(parsed.success ? parsed.data : []);
  } catch {
    return new Set();
  }
}

/** Per-user module activation preferences (D47) — the header "Modules" dialog. */
export const settingsModule: BffModule = {
  id: "settings",
  register(api, ctx) {
    api.get("/modules", async (req) => ({
      disabled: [...disabledModules(ctx, req.user.sub)],
    }));

    api.put("/modules", async (req, reply) => {
      const parsed = putSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "expected {disabled: string[]}" });
      const known = knownIds(ctx);
      for (const id of parsed.data.disabled) {
        if (!known.has(id)) return reply.code(400).send({ error: `unknown module: ${id}` });
        if (LOCKED.has(id)) return reply.code(400).send({ error: `${id} cannot be disabled` });
      }
      ctx.store.saveModuleSettings(req.user.sub, "settings", JSON.stringify(parsed.data));
      return { disabled: parsed.data.disabled };
    });
  },
};
