import { z } from "zod";
import type { AppContext } from "../app.js";
import { type AuthenticatedNextcloud, NextcloudError } from "../nextcloud/client.js";
import type { BffModule, ChatTool } from "./types.js";

/** Authenticated client for the caller, or null when Nextcloud is disconnected. */
function ncFor(ctx: AppContext, sub: string): AuthenticatedNextcloud | null {
  const cred = ctx.store.getCredential(sub);
  return cred
    ? ctx.nextcloud.withCredentials(cred.loginName, ctx.secrets.open(cred.appPasswordSealed))
    : null;
}

const configSchema = z.object({
  /** WebDAV folder holding one folder per recipe (Cookbook layout). */
  FOLDER: z.string().min(1).default("Recipes"),
});

// -- schema.org Recipe parsing -------------------------------------------------

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

const keywords = (v: unknown): string[] =>
  asArray(v)
    .flatMap((k) => (typeof k === "string" ? k.split(",") : []))
    .map((k) => k.trim())
    .filter(Boolean);

const firstString = (v: unknown): string | null => {
  for (const item of asArray(v)) {
    const s = str(item) ?? str((item as Record<string, unknown>)?.url);
    if (s) return s;
  }
  return null;
};

const instructions = (v: unknown): string[] =>
  asArray(v).flatMap((step) => {
    if (typeof step === "string") return step.trim() ? [step] : [];
    const o = step as Record<string, unknown>;
    if (str(o.text)) return [o.text as string];
    if (Array.isArray(o.itemListElement)) return instructions(o.itemListElement);
    return [];
  });

export interface ParsedRecipe {
  id: string;
  name: string;
  description: string | null;
  hasImage: boolean;
  keywords: string[];
  category: string | null;
  cuisine: string | null;
  servings: string | null;
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  ingredients: string[];
  instructions: string[];
}

function parseRecipe(id: string, raw: unknown): ParsedRecipe | null {
  const r = raw as Record<string, unknown>;
  // Cookbook nests the recipe under @graph on some exports.
  const node =
    (Array.isArray(r["@graph"])
      ? (r["@graph"] as Record<string, unknown>[]).find((n) =>
          asArray(n["@type"]).includes("Recipe"),
        )
      : null) ?? r;
  const name = str(node.name);
  if (!name) return null;
  return {
    id,
    name,
    description: str(node.description),
    hasImage: firstString(node.image) !== null,
    keywords: keywords(node.keywords),
    category: firstString(node.recipeCategory),
    cuisine: firstString(node.recipeCuisine),
    servings:
      firstString(node.recipeYield) ??
      (typeof node.recipeYield === "number" ? String(node.recipeYield) : null),
    prepTime: str(node.prepTime),
    cookTime: str(node.cookTime),
    totalTime: str(node.totalTime),
    ingredients: asArray(node.recipeIngredient).flatMap((i) => (str(i) ? [i as string] : [])),
    instructions: instructions(node.recipeInstructions),
  };
}

const safeId = (id: string) => id !== "" && !id.split("/").includes("..") && !id.startsWith("/");

/** Fetch and parse `<folder>/<dir>/recipe.json`; null when absent/unparseable. */
async function readRecipe(
  nc: AuthenticatedNextcloud,
  folder: string,
  dir: string,
): Promise<ParsedRecipe | null> {
  try {
    const raw = await nc.davGetFile(`${folder}/${dir}/recipe.json`);
    return parseRecipe(dir, JSON.parse(raw));
  } catch (e) {
    if (e instanceof NextcloudError && e.status === 404) return null;
    if (e instanceof SyntaxError) return null; // recipe.json exists but isn't JSON
    throw e;
  }
}

/**
 * Recipes (D55): read-only view of the user's Nextcloud Cookbook folder —
 * one directory per recipe containing a schema.org `recipe.json`. Nothing is
 * mirrored locally; the folder is the source of truth.
 */
export const recipesModule: BffModule<z.infer<typeof configSchema>> = {
  id: "recipes",
  requires: ["nextcloud"],
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "recipes_search",
        description:
          "Search the user's recipe collection (Nextcloud Cookbook) by name, keyword or ingredient. Returns matching recipes with their ingredient lists.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional case-insensitive filter over name, keywords and ingredients.",
            },
          },
        },
        async call(args, sub) {
          const nc = ncFor(ctx, sub);
          if (!nc) return { error: "nextcloud is not connected" };
          const q = typeof args.query === "string" ? args.query.toLowerCase() : "";
          const all = await listRecipes(nc, "Recipes");
          const hits = all
            .filter(
              (r) =>
                !q ||
                `${r.name} ${r.keywords.join(" ")} ${r.ingredients.join(" ")}`
                  .toLowerCase()
                  .includes(q),
            )
            .slice(0, 30)
            .map((r) => ({ id: r.id, name: r.name, ingredients: r.ingredients }));
          return { recipes: hits };
        },
      },
    ];
  },

  register(api, ctx, config) {
    api.get("", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      return { recipes: await listRecipes(nc, config.FOLDER) };
    });

    api.get("/:id", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const { id } = req.params as { id: string };
      if (!safeId(id)) return reply.code(400).send({ error: "invalid recipe id" });
      const recipe = await readRecipe(nc, config.FOLDER, id);
      if (!recipe) return reply.code(404).send({ error: "recipe not found" });
      return { recipe };
    });

    /** Recipe photo — tries full.jpg then thumb.jpg (Cookbook's filenames). */
    api.get("/:id/image", async (req, reply) => {
      const nc = ncFor(ctx, req.user.sub);
      if (!nc) return reply.code(424).send({ error: "nextcloud is not connected" });
      const { id } = req.params as { id: string };
      if (!safeId(id)) return reply.code(400).send({ error: "invalid recipe id" });
      for (const file of ["full.jpg", "thumb.jpg"]) {
        try {
          const res = await nc.davGetResponse(`${config.FOLDER}/${id}/${file}`);
          return reply
            .header("Content-Type", res.headers.get("content-type") ?? "image/jpeg")
            .header("Cache-Control", "private, max-age=300")
            .send(Buffer.from(await res.arrayBuffer()));
        } catch (e) {
          if (!(e instanceof NextcloudError) || e.status !== 404) throw e;
        }
      }
      return reply.code(404).send({ error: "no image" });
    });
  },
};

/** PROPFIND the recipes folder, then parse every subfolder's recipe.json. */
async function listRecipes(nc: AuthenticatedNextcloud, folder: string) {
  let entries: Awaited<ReturnType<AuthenticatedNextcloud["davPropfind"]>>;
  try {
    entries = await nc.davPropfind(folder, 1);
  } catch (e) {
    if (e instanceof NextcloudError && e.status === 404) return [];
    throw e;
  }
  const dirs = entries.filter((e) => e.isCollection && e.relPath !== folder);
  const recipes = await Promise.all(
    dirs.map((d) =>
      readRecipe(nc, folder, d.relPath.slice(folder.length).replace(/^\/+|\/+$/g, "")),
    ),
  );
  return recipes
    .filter((r): r is ParsedRecipe => r !== null)
    .map(
      ({
        id,
        name,
        description,
        hasImage,
        keywords,
        category,
        cuisine,
        servings,
        totalTime,
        ingredients,
      }) => ({
        id,
        name,
        description,
        hasImage,
        keywords,
        category,
        cuisine,
        servings,
        totalTime,
        ingredients,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
