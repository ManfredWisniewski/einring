import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { AppContext } from "../app.js";

/**
 * BFF half of a module (D32). `register` mounts under `/api/<id>/`.
 * `configSchema` validates this module's `MODULE_<ID>_*` env vars (prefix stripped);
 * it runs at startup only when the module is enabled.
 */
export interface BffModule<TConfig = unknown> {
  id: string;
  /** Services the module needs (e.g. "nextcloud") — reported via GET /api/modules. */
  requires?: string[];
  configSchema?: z.ZodType<TConfig>;
  register(api: FastifyInstance, ctx: AppContext, config: TConfig): void;
}
