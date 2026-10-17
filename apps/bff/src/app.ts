import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { requireAuth, type TokenVerifier } from "./auth.js";
import type { Config } from "./config.js";
import type { SecretBox } from "./crypto.js";
import type { Store } from "./db.js";
import { LlmError } from "./llm/client.js";
import { resolveModules } from "./modules/registry.js";
import { type Fetch, NextcloudClient, NextcloudError } from "./nextcloud/client.js";
import { registerNextcloudPublicRoutes, registerNextcloudRoutes } from "./routes/nextcloud.js";

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

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Instance name into <title>, theme + whitelabel CSS variable overrides as style blocks. */
function patchIndexHtml(html: string, config: Config): string {
  let out = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(config.INSTANCE_NAME)}</title>`,
  );
  const decls = (vars?: Record<string, string>) =>
    Object.entries(vars ?? {})
      .map(([k, v]) => `${k}:${v}`)
      .join(";");
  const blocks: string[] = [];
  const theme = config.INSTANCE_THEME;
  if (theme) {
    blocks.push(`:root{${decls(theme.light)}}[data-theme="dark"]{${decls(theme.dark)}}`);
  }
  if (config.INSTANCE_CSS_VARS && Object.keys(config.INSTANCE_CSS_VARS).length > 0) {
    blocks.push(`:root{${decls(config.INSTANCE_CSS_VARS)}}`);
  }
  if (blocks.length > 0) {
    out = out.replace("</head>", `<style>${blocks.join("")}</style></head>`);
  }
  return out;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Enabled modules resolve + validate their MODULE_<ID>_* env here, so bad config fails at startup.
  const modules = resolveModules(deps.config);
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
    if (err instanceof LlmError) {
      request.log.warn({ status: err.status, msg: err.message }, "llm error");
      return reply
        .code(502)
        .send({ error: "llm", detail: err.message, upstreamStatus: err.status });
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.get("/healthz", async () => ({ ok: true }));
  // Public instance config — the app reads the deployment name before login, so no auth.
  app.get("/api/config", async () => ({
    name: deps.config.INSTANCE_NAME,
    // tagline: undefined = app default, "" = hidden, string = override
    tagline: deps.config.INSTANCE_TAGLINE,
    cssVars: deps.config.INSTANCE_CSS_VARS,
    theme: deps.config.INSTANCE_THEME,
    // Public OIDC client settings — the SPA prefers these over its baked VITE_* values
    // so one image serves deployments with different Authentik providers.
    authentik: {
      issuer: deps.config.AUTHENTIK_ISSUER,
      clientId: deps.config.AUTHENTIK_CLIENT_ID,
    },
  }));

  // Public scope: the login-flow endpoints also answer unauthenticated callers
  // (embedded deployments sign in via Nextcloud — see D19 amendment).
  await app.register(
    async (api) => {
      registerNextcloudPublicRoutes(api, ctx);
    },
    { prefix: "/api" },
  );

  await app.register(
    async (api) => {
      api.addHook("preHandler", requireAuth(deps.verifyToken));
      api.get("/me", async (request) => request.user);
      api.get("/modules", async () => ({
        modules: modules.map(({ module }) => ({ id: module.id, requires: module.requires ?? [] })),
      }));
      registerNextcloudRoutes(api, ctx);
      for (const { module, config } of modules) {
        api.register(
          (sub, _opts, done) => {
            module.register(sub, ctx, config);
            done();
          },
          { prefix: `/${module.id}` },
        );
      }
    },
    { prefix: "/api" },
  );

  const staticDir = deps.config.STATIC_DIR
    ? resolve(deps.config.STATIC_DIR)
    : resolve(import.meta.dirname, "../../app/dist");
  if (existsSync(staticDir)) {
    // index.html is excluded so "/" and SPA routes fall through to the not-found handler,
    // which serves it with the instance name injected into <title>.
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      index: false,
      globIgnore: ["index.html"],
    });
    let indexHtml: string | undefined;
    // The instance's own Nextcloud may frame the app (External sites embed).
    const frameAncestors = `frame-ancestors 'self' ${new URL(deps.config.NEXTCLOUD_URL).origin}`;
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        indexHtml ??= patchIndexHtml(
          await readFile(resolve(staticDir, "index.html"), "utf8"),
          deps.config,
        );
        return reply
          .header("Content-Security-Policy", frameAncestors)
          .type("text/html")
          .send(indexHtml);
      }
      return reply.code(404).send({ error: "not found" });
    });
    app.log.info({ staticDir }, "serving web build");
  }

  return app;
}
