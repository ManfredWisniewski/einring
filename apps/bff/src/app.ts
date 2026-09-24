import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { requireAuth, type TokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { Store } from "./db.js";
import { type Fetch, NextcloudClient, NextcloudError } from "./nextcloud/client.js";
import { registerNextcloudRoutes } from "./routes/nextcloud.js";
import { registerTablesRoutes } from "./routes/tables.js";

export interface AppDeps {
  config: Config;
  store: Store;
  secrets: SecretBox;
  verifyToken: TokenVerifier;
  fetchImpl?: Fetch;
  logger?: boolean | object;
}

export interface AppContext extends AppDeps {
  nextcloud: NextcloudClient;
}

/** Origins Capacitor WebViews use on device, plus the configured public URL and the Vite dev server. */
export function allowedOrigins(config: Config): string[] {
  return [
    new URL(config.PUBLIC_URL).origin,
    "http://localhost:5173",
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
  ];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? { level: deps.config.LOG_LEVEL } });
  const ctx: AppContext = {
    ...deps,
    nextcloud: new NextcloudClient(deps.config.NEXTCLOUD_URL, deps.fetchImpl ?? fetch),
  };

  await app.register(cors, { origin: allowedOrigins(deps.config), credentials: false });

  app.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    if (err instanceof NextcloudError) {
      request.log.warn({ status: err.status, msg: err.message }, "nextcloud error");
      const code = err.status === 401 ? 424 : 502;
      return reply
        .code(code)
        .send({ error: "nextcloud", detail: err.message, upstreamStatus: err.status });
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.get("/healthz", async () => ({ ok: true }));

  await app.register(
    async (api) => {
      api.addHook("preHandler", requireAuth(deps.verifyToken));
      api.get("/me", async (request) => request.user);
      registerNextcloudRoutes(api, ctx);
      registerTablesRoutes(api, ctx);
    },
    { prefix: "/api" },
  );

  const staticDir = deps.config.STATIC_DIR
    ? resolve(deps.config.STATIC_DIR)
    : resolve(import.meta.dirname, "../../app/dist");
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info({ staticDir }, "serving web build");
  }

  return app;
}
