import { z } from "zod";
import type { BffModule, ChatTool, NotificationItem, NotificationSource } from "./types.js";

const configSchema = z.object({
  /** Min seconds between upstream refreshes per user (lazy, on GET /notifications); 0 = every request. */
  REFRESH_SECONDS: z.coerce.number().int().min(0).default(60),
});
type EinHubConfig = z.infer<typeof configSchema>;

interface Source {
  id: string;
  poll: NotificationSource["poll"];
}

export const einhubModule: BffModule<EinHubConfig> = {
  id: "einhub",
  configSchema,

  chatTools(ctx): ChatTool[] {
    return [
      {
        name: "einhub_notifications",
        description:
          "List the user's recent einring hub notifications (module, title, body, read state) collected from modules like email and gotify.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max notifications to return (default 10, max 50)",
            },
          },
        },
        async call(args, sub) {
          const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
          const rows = ctx.store.listNotifications(sub, limit);
          return {
            notifications: rows.map((r) => ({
              module: r.module,
              title: r.title,
              body: r.body,
              at: r.at,
              read: r.read === 1,
            })),
          };
        },
      },
    ];
  },

  register(api, ctx, config) {
    // Collect every other enabled module's notification feed (D42).
    const sources: Source[] = ctx.modules
      .filter((r) => r.module.id !== "einhub")
      .flatMap((r) => {
        const src = r.module.notifications?.(ctx, r.config);
        return src ? [{ id: r.module.id, poll: src.poll }] : [];
      });

    /** Per-user refresh throttle — upstreams are only hit while the app is open. */
    const lastRefresh = new Map<string, number>();

    async function refresh(sub: string): Promise<void> {
      const last = lastRefresh.get(sub) ?? 0;
      if (Date.now() - last < config.REFRESH_SECONDS * 1000) return;
      lastRefresh.set(sub, Date.now());
      for (const { id, poll } of sources) {
        let items: NotificationItem[] | undefined;
        try {
          items = await poll(sub);
        } catch {
          continue; // a broken source must never break the hub
        }
        if (!items?.length) continue;
        // First contact with a module: existing upstream items are history,
        // not alerts — seed them as read (D42).
        const seed = !ctx.store.hasNotificationsFor(sub, id);
        for (const n of items) {
          ctx.store.insertNotification({
            sub,
            module: id,
            sourceId: n.sourceId,
            title: n.title,
            body: n.body ?? null,
            at: n.at ?? new Date().toISOString(),
            read: seed,
          });
        }
      }
    }

    api.get("/notifications", async (req) => {
      await refresh(req.user.sub);
      const limit = Math.min(
        Math.max(Number((req.query as { limit?: string }).limit) || 50, 1),
        200,
      );
      const rows = ctx.store.listNotifications(req.user.sub, limit);
      return {
        notifications: rows.map((r) => ({
          id: r.id,
          module: r.module,
          title: r.title,
          body: r.body,
          at: r.at,
          read: r.read === 1,
        })),
        unread: ctx.store.unreadNotificationCount(req.user.sub),
      };
    });

    api.post("/notifications/:id/read", async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "invalid id" });
      if (!ctx.store.markNotificationRead(req.user.sub, id))
        return reply.code(404).send({ error: "unknown notification" });
      return { read: true };
    });

    api.post("/read-all", async (req) => {
      ctx.store.markAllNotificationsRead(req.user.sub);
      return { unread: 0 };
    });
  },
};
