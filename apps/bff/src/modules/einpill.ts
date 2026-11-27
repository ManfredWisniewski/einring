import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppContext } from "../app.js";
import type { EinpillMedicationRow, Store } from "../db.js";
import { projectInventory, revisionForDate } from "./einpill/projection.js";
import type { BffModule } from "./types.js";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });

const dosageFields = {
  pillsPerPackage: z.number().int().min(1).max(10_000),
  dailyUsage: z
    .number()
    .finite()
    .gt(0)
    .max(100)
    .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-7),
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ...dosageFields,
  effectiveDate: dateSchema.optional(),
});

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.archived !== undefined);

const revisionSchema = z.object({
  effectiveDate: dateSchema,
  ...dosageFields,
});

const packageSchema = z.object({ addedDate: dateSchema });

const todayUtc = () => new Date().toISOString().slice(0, 10);
const usageMilli = (dailyUsage: number) => Math.round(dailyUsage * 1000);

function validationError(reply: { code: (n: number) => { send: (body: unknown) => unknown } }) {
  return reply.code(400).send({ error: "invalid request" });
}

function apiMedication(store: Store, med: EinpillMedicationRow, today: string) {
  const revisions = store.listEinpillRevisions(med.sub, med.id);
  const packages = store.listEinpillPackages(med.sub, med.id);
  const projection = projectInventory(revisions, packages, today);
  const current = revisionForDate(revisions, today);
  return {
    id: med.id,
    name: med.name,
    pillsPerPackage: current.pillsPerPackage,
    dailyUsage: current.usageMilli / 1000,
    archived: med.archived === 1,
    revisions: revisions.map((r) => ({
      effectiveDate: r.effectiveDate,
      pillsPerPackage: r.pillsPerPackage,
      dailyUsage: r.usageMilli / 1000,
    })),
    packages: packages.map((p) => ({ id: p.id, addedDate: p.addedDate })),
    projection,
  };
}

function listMedications(store: Store, sub: string, includeArchived: boolean, today: string) {
  return store
    .listEinpillMedications(sub, includeArchived)
    .map((m) => apiMedication(store, m, today))
    .sort((a, b) => {
      if (a.projection.runoutDate === null && b.projection.runoutDate === null) {
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      if (a.projection.runoutDate === null) return 1;
      if (b.projection.runoutDate === null) return -1;
      return (
        a.projection.runoutDate.localeCompare(b.projection.runoutDate) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      );
    });
}

function loadOwnMedication(ctx: AppContext, sub: string, id: string) {
  return ctx.store.getEinpillMedication(sub, id);
}

export const einpillModule: BffModule = {
  id: "einpill",
  version: "0.1.0",

  notifications(ctx) {
    return {
      async poll(sub) {
        const today = todayUtc();
        return listMedications(ctx.store, sub, false, today)
          .filter((m) => m.projection.state !== "untracked" && m.projection.remainingDays <= 14)
          .map((m) => {
            const exhausted = m.projection.state === "exhausted";
            const runoutDate = m.projection.runoutDate ?? today;
            return {
              sourceId: `restock-${m.id}-${runoutDate}`,
              title: exhausted ? `${m.name} is out of stock` : `${m.name} runs out soon`,
              body: exhausted
                ? `Stock has been exhausted since ${runoutDate}.`
                : `Projected run-out date: ${runoutDate} (${m.projection.remainingDays} days remaining).`,
              at: new Date().toISOString(),
              i18n: {
                titleKey: exhausted
                  ? "modules.einpill.notificationOutTitle"
                  : "modules.einpill.notificationRestockTitle",
                titleParams: { name: m.name },
                bodyKey: exhausted
                  ? "modules.einpill.notificationOutBody"
                  : "modules.einpill.notificationRestockBody",
                bodyParams: { runoutDate, days: m.projection.remainingDays },
              },
            };
          });
      },
    };
  },

  register(api, ctx) {
    const store = ctx.store;

    api.get("/medications", async (req) => {
      const q = req.query as { includeArchived?: string };
      const includeArchived = q.includeArchived === "1" || q.includeArchived === "true";
      return { medications: listMedications(store, req.user.sub, includeArchived, todayUtc()) };
    });

    api.post("/medications", async (req, reply) => {
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(reply);
      const id = randomUUID();
      const today = todayUtc();
      const med = store.createEinpillMedication(
        { id, sub: req.user.sub, name: parsed.data.name, archived: 0 },
        {
          id: randomUUID(),
          sub: req.user.sub,
          medicationId: id,
          effectiveDate: parsed.data.effectiveDate ?? today,
          pillsPerPackage: parsed.data.pillsPerPackage,
          usageMilli: usageMilli(parsed.data.dailyUsage),
        },
      );
      return reply.code(201).send({ medication: apiMedication(store, med, today) });
    });

    api.patch("/medications/:id", async (req, reply) => {
      const parsed = patchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(reply);
      const id = (req.params as { id: string }).id;
      const updated = store.updateEinpillMedication(req.user.sub, id, {
        ...(parsed.data.name !== undefined && { name: parsed.data.name }),
        ...(parsed.data.archived !== undefined && { archived: parsed.data.archived ? 1 : 0 }),
      });
      if (!updated) return reply.code(404).send({ error: "unknown medication" });
      return { medication: apiMedication(store, updated, todayUtc()) };
    });

    api.put("/medications/:id/revision", async (req, reply) => {
      const parsed = revisionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(reply);
      const id = (req.params as { id: string }).id;
      const med = loadOwnMedication(ctx, req.user.sub, id);
      if (!med) return reply.code(404).send({ error: "unknown medication" });
      store.upsertEinpillRevision({
        id: randomUUID(),
        sub: req.user.sub,
        medicationId: id,
        effectiveDate: parsed.data.effectiveDate,
        pillsPerPackage: parsed.data.pillsPerPackage,
        usageMilli: usageMilli(parsed.data.dailyUsage),
      });
      return { medication: apiMedication(store, med, todayUtc()) };
    });

    api.delete("/medications/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!store.deleteEinpillMedication(req.user.sub, id)) {
        return reply.code(404).send({ error: "unknown medication" });
      }
      return reply.code(204).send();
    });

    api.post("/medications/:id/packages", async (req, reply) => {
      const parsed = packageSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(reply);
      const today = todayUtc();
      if (parsed.data.addedDate > today) return validationError(reply);
      const id = (req.params as { id: string }).id;
      const med = loadOwnMedication(ctx, req.user.sub, id);
      if (!med) return reply.code(404).send({ error: "unknown medication" });
      store.createEinpillPackage({
        id: randomUUID(),
        sub: req.user.sub,
        medicationId: id,
        addedDate: parsed.data.addedDate,
      });
      return reply.code(201).send({ medication: apiMedication(store, med, today) });
    });

    api.patch("/packages/:id", async (req, reply) => {
      const parsed = packageSchema.safeParse(req.body ?? {});
      if (!parsed.success) return validationError(reply);
      const today = todayUtc();
      if (parsed.data.addedDate > today) return validationError(reply);
      const id = (req.params as { id: string }).id;
      const pkg = store.getEinpillPackage(req.user.sub, id);
      if (!pkg) return reply.code(404).send({ error: "unknown package" });
      const updated = store.updateEinpillPackage(req.user.sub, id, parsed.data.addedDate);
      const med = updated ? loadOwnMedication(ctx, req.user.sub, updated.medicationId) : undefined;
      if (!updated || !med) return reply.code(404).send({ error: "unknown package" });
      return { medication: apiMedication(store, med, today) };
    });

    api.delete("/packages/:id", async (req, reply) => {
      const id = (req.params as { id: string }).id;
      if (!store.deleteEinpillPackage(req.user.sub, id)) {
        return reply.code(404).send({ error: "unknown package" });
      }
      return reply.code(204).send();
    });
  },
};
