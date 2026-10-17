import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { AppContext } from "../app.js";

/**
 * A tool a module lends to EinChat (D41). Names should carry the module prefix
 * (`yamtrack_search_media`). `call` runs inside the einchat message loop with the
 * caller's `sub` — resolve per-user credentials there, never at register time.
 */
export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema object for `call`'s argument. */
  parameters: Record<string, unknown>;
  call(args: Record<string, unknown>, sub: string): Promise<unknown>;
}

/**
 * One upstream event for einhub (D42). `sourceId` is the dedupe key —
 * upstream-unique within the module (Gotify message id, IMAP uid).
 */
export interface NotificationItem {
  sourceId: string;
  title: string;
  body?: string;
  /** Event time (ISO); defaults to insert time. */
  at?: string;
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
  /** Services the module needs (e.g. "nextcloud") — reported via GET /api/modules. */
  requires?: string[];
  configSchema?: z.ZodType<TConfig>;
  chatTools?(ctx: AppContext, config: TConfig): ChatTool[];
  notifications?(ctx: AppContext, config: TConfig): NotificationSource;
  register(api: FastifyInstance, ctx: AppContext, config: TConfig): void;
}
