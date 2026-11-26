import type { AppContext } from "../../app.js";
import { itsaplanTimeProvider } from "./providers/itsaplan.js";

/** Uniform client shape a time-tracking provider exposes (itsaplan: team). */
export interface MappedClient {
  provider: string;
  externalId: string;
  name: string;
}

/** Uniform project shape (itsaplan: board). */
export interface MappedProject {
  provider: string;
  externalId: string;
  clientExternalId: string | null;
  name: string;
}

/** Uniform task shape (itsaplan: assigned open ticket). */
export interface MappedTask {
  provider: string;
  externalId: string;
  projectExternalId: string;
  name: string;
  url: string | null;
}

export interface ProviderLists {
  clients: MappedClient[];
  projects: MappedProject[];
  tasks: MappedTask[];
}

/**
 * A project-management source eintime maps its dimensions from (spec eintime
 * FR-009). `list` resolves one user's clients/projects/tasks; it degrades to
 * empty lists when the provider is unconnected or upstream fails — it never throws.
 */
export interface TimeProvider {
  id: string;
  list(ctx: AppContext, sub: string): Promise<ProviderLists>;
}

/**
 * Provider registry — itsaplan is the sole adapter in v1 (owner decision:
 * registry seam only). A second provider docks on by implementing
 * `TimeProvider` and appending itself here; nothing else changes.
 */
export const timeProviders: TimeProvider[] = [itsaplanTimeProvider];

/** Merged dimension lists across all registered providers. */
export async function listMapped(ctx: AppContext, sub: string): Promise<ProviderLists> {
  const out: ProviderLists = { clients: [], projects: [], tasks: [] };
  for (const p of timeProviders) {
    try {
      const lists = await p.list(ctx, sub);
      out.clients.push(...lists.clients);
      out.projects.push(...lists.projects);
      out.tasks.push(...lists.tasks);
    } catch {
      // A broken provider must not take the mapping surface down (NFR-002).
    }
  }
  return out;
}
