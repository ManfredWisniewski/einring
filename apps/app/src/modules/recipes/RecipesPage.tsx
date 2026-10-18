import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRecipe, useRecipeImage, useRecipes } from "@/api/hooks";
import type { RecipeListItem } from "@/api/types";
import { NextcloudGate } from "@/components/NextcloudGate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** `PT1H10M` → "1 h 10 min" (schema.org durations are ISO-8601). */
function fmtDuration(iso: string | null, t: TFunction) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!m) return iso;
  const parts: string[] = [];
  if (m[1]) parts.push(t("modules.recipes.days", { count: Number(m[1]) }));
  if (m[2]) parts.push(t("modules.recipes.hours", { count: Number(m[2]) }));
  if (m[3]) parts.push(t("modules.recipes.minutes", { count: Number(m[3]) }));
  return parts.join(" ") || iso;
}

function RecipeImage({ id, name }: { id: string; name: string }) {
  const img = useRecipeImage(id, true);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!img.data) return;
    const u = URL.createObjectURL(img.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [img.data]);
  if (!url) return null;
  return <img className="recipes-image" src={url} alt={name} />;
}

function RecipeDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const { data } = useRecipe(id);
  const r = data?.recipe;
  if (!r) return null;
  const times = [
    [t("modules.recipes.prep"), fmtDuration(r.prepTime, t)],
    [t("modules.recipes.cook"), fmtDuration(r.cookTime, t)],
    [t("modules.recipes.total"), fmtDuration(r.totalTime, t)],
  ].filter(([, v]) => v);
  return (
    <div className="stack">
      <div className="row">
        <Button size="sm" variant="ghost" onClick={onBack}>
          {t("modules.recipes.back")}
        </Button>
      </div>
      <h2>{r.name}</h2>
      {r.hasImage && <RecipeImage id={r.id} name={r.name} />}
      {r.description && <p>{r.description}</p>}
      {(times.length > 0 || r.servings) && (
        <p className="muted">
          {r.servings ? `${t("modules.recipes.servings", { count: r.servings })}` : null}
          {r.servings && times.length ? " · " : ""}
          {times.map(([label, v]) => `${label}: ${v}`).join(" · ")}
        </p>
      )}
      {r.keywords.length > 0 && <p className="muted">{r.keywords.join(" · ")}</p>}
      {r.ingredients.length > 0 && (
        <>
          <h3>{t("modules.recipes.ingredients")}</h3>
          <ul className="recipes-ingredients">
            {r.ingredients.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </>
      )}
      {r.instructions.length > 0 && (
        <>
          <h3>{t("modules.recipes.instructions")}</h3>
          <ol className="recipes-steps">
            {r.instructions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export default function RecipesPage() {
  const { t } = useTranslation();
  const { data } = useRecipes();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const recipes = useMemo(() => {
    const q = query.toLowerCase();
    return (data?.recipes ?? []).filter(
      (r: RecipeListItem) => !q || `${r.name} ${r.keywords.join(" ")}`.toLowerCase().includes(q),
    );
  }, [data, query]);

  return (
    <NextcloudGate>
      {open ? (
        <RecipeDetail id={open} onBack={() => setOpen(null)} />
      ) : (
        <div className="stack">
          <Input
            type="search"
            placeholder={t("modules.recipes.search")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            aria-label={t("modules.recipes.search")}
          />
          <ul className="recipes-list">
            {recipes.map((r) => (
              <li key={r.id} className="eindav-row">
                <button
                  type="button"
                  className="linklike recipes-row__main"
                  onClick={() => setOpen(r.id)}
                >
                  <strong>{r.name}</strong>
                  <span className="muted">
                    {[
                      r.totalTime ? fmtDuration(r.totalTime, t) : null,
                      r.keywords.join(" · ") || null,
                    ]
                      .filter(Boolean)
                      .join(" — ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {data && recipes.length === 0 && <p className="muted">{t("modules.recipes.empty")}</p>}
        </div>
      )}
    </NextcloudGate>
  );
}
