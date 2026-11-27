import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { AppContext } from "../app.js";
import type { AuthUser } from "../auth.js";

/**
 * A tool a module lends to EinChat (D41). Names should carry the module prefix
 * (`yamtrack_search_media`). `call` runs inside the einchat message loop with the
 * caller's `sub` — resolve per-user credentials there, never at register time.
 */
export interface ChatTool {
  name: string;
  description: string;
  /**
   * `"einchat"` exposes the tool only inside the app chat; tools default to
   * being shared with the einchat-mcp surface as well (`"all"`).
   */
  scope?: "einchat" | "all";
  /** JSON Schema object for `call`'s argument. */
  parameters: Record<string, unknown>;
  call(args: Record<string, unknown>, sub: string, user?: AuthUser): Promise<unknown>;
}

/**
 * One upstream event for einhub (D42). `sourceId` is the dedupe key —
 * upstream-unique within the module (Gotify message id, IMAP uid).
 */
export interface NotificationItemI18n {
  titleKey?: string;
  titleParams?: Record<string, unknown>;
  bodyKey?: string;
  bodyParams?: Record<string, unknown>;
}

export interface NotificationItem {
  sourceId: string;
  title: string;
  body?: string;
  /** Event time (ISO); defaults to insert time. */
  at?: string;
  /** Optional structured translation metadata; title/body remain plain-text fallbacks. */
  i18n?: NotificationItemI18n;
}

/**
 * A module's notification feed for einhub (D42). `poll` returns the user's
 * recent upstream items — `[]` when unconnected or on failure, never throws.
 */
export interface NotificationSource {
  poll(sub: string): Promise<NotificationItem[]>;
}

/**
 * BFF half of a module (D32). `register` mounts under `/api/<id>/`.
 * `configSchema` validates this module's `MODULE_<ID>_*` env vars (prefix stripped);
 * it runs at startup only when the module is enabled. `chatTools` optionally
 * exposes tools to the einchat module (collected from all enabled modules).
 * `notifications` optionally exposes an event feed to the einhub module (D42).
 */
export interface BffModule<TConfig = unknown> {
  id: string;
  /** Semver feature level of the module (D69) — bumped by the change's author,
   * reported on GET /api/modules. */
  version: string;
  /** Services the module needs (e.g. "nextcloud") — reported via GET /api/modules. */
  requires?: string[];
  configSchema?: z.ZodType<TConfig>;
  chatTools?(ctx: AppContext, config: TConfig): ChatTool[];
  notifications?(ctx: AppContext, config: TConfig): NotificationSource;
  /** Per-user visibility check — `GET /api/modules` drops the module when this
   *  returns false (e.g. aufmass hides when the user can read no tables). */
  hasAccess?(ctx: AppContext, user: AuthUser, config: TConfig): Promise<boolean>;
  register(api: FastifyInstance, ctx: AppContext, config: TConfig): void;
}
