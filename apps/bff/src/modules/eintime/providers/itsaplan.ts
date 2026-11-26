import type { AppContext } from "../../../app.js";
import { listBoards, listTickets } from "../../itsaplan.js";
import type {
  MappedClient,
  MappedProject,
  MappedTask,
  ProviderLists,
  TimeProvider,
} from "../providers.js";

const PROVIDER = "itsaplan";

/**
 * itsaplan adapter (spec eintime FR-009): teams → clients, member boards →
 * projects, assigned open tickets → tasks. Reuses the itsaplan module's
 * list functions — the credential stays in `service_credentials`; an absent
 * or rejected credential yields empty lists (NFR-002).
 */
export const itsaplanTimeProvider: TimeProvider = {
  id: PROVIDER,
  async list(ctx: AppContext, sub: string): Promise<ProviderLists> {
    const [boardsRes, ticketsRes] = await Promise.all([
      listBoards(ctx, sub),
      listTickets(ctx, sub, 500),
    ]);
    const clients = new Map<string, MappedClient>();
    const projects: MappedProject[] = [];
    const boards = "boards" in boardsRes ? (boardsRes.boards ?? []) : [];
    for (const b of boards.filter((b) => !b.archived)) {
      if (!clients.has(b.teamRef)) {
        clients.set(b.teamRef, {
          provider: PROVIDER,
          externalId: b.teamRef,
          name: b.teamName || b.teamRef,
        });
      }
      projects.push({
        provider: PROVIDER,
        externalId: b.ref,
        clientExternalId: b.teamRef,
        name: b.name,
      });
    }
    const tickets = "tickets" in ticketsRes ? (ticketsRes.tickets ?? []) : [];
    const tasks: MappedTask[] = tickets.map((t) => ({
      provider: PROVIDER,
      externalId: String(t.id),
      projectExternalId: t.projectRef,
      name: `${t.identifier}: ${t.title}`,
      url: t.url,
    }));
    return { clients: [...clients.values()], projects, tasks };
  },
};
