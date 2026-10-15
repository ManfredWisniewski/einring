import { z } from "zod";

const schema = z.object({
  AUTHENTIK_ISSUER: z.url(),
  AUTHENTIK_CLIENT_ID: z.string().min(1),
  NEXTCLOUD_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  /** Comma-separated enabled module ids; absent = all registered modules enabled. */
  MODULES: z.string().optional(),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  ENCRYPTION_KEY: z.base64().refine((k) => Buffer.from(k, "base64").length === 32, {
    message: "ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
  /** Display name of this deployment, shown in the app header, document title and info dialog. */
  INSTANCE_NAME: z.string().min(1).default("Einring"),
  /** Tagline shown on the login page. Unset = the app's default; empty string hides it. */
  INSTANCE_TAGLINE: z.string().optional(),
  /**
   * Whitelabel accent/branding: JSON map of CSS variable overrides, e.g.
   * '{"--accent-base":"#b91c1c","--accent-subtle":"#fee2e2"}' — injected into index.html.
   */
  INSTANCE_CSS_VARS: z.string().optional(),
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

type BaseConfig = Omit<z.infer<typeof schema>, "MODULES" | "INSTANCE_CSS_VARS">;

export interface Config extends BaseConfig {
  /** Parsed + validated INSTANCE_CSS_VARS, or undefined when unset. */
  INSTANCE_CSS_VARS?: Record<string, string>;
  /** Enabled module ids, or undefined when MODULES is unset (all enabled). */
  modules?: string[];
  /** Raw `MODULE_*` env vars; per-module extraction happens in modules/registry.ts. */
  moduleEnv: Record<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  const { MODULES, INSTANCE_CSS_VARS, ...rest } = result.data;
  const cssVars = parseCssVars(INSTANCE_CSS_VARS);
  const moduleEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) => /^MODULE_[A-Z0-9]+_[A-Z0-9_]+$/.test(k) && typeof v === "string",
    ),
  ) as Record<string, string>;
  return {
    ...rest,
    INSTANCE_CSS_VARS: cssVars,
    modules: MODULES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    moduleEnv,
  };
}

function parseCssVars(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const fail = (msg: string) => {
    throw new Error(`Invalid configuration:\n  INSTANCE_CSS_VARS: ${msg}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("must be a JSON object");
  }
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^--[a-z0-9-]+$/i.test(k)) fail(`key "${k}" is not a --css-variable`);
    if (typeof v !== "string" || /[<>{};]/.test(v)) {
      fail(`value of "${k}" is not a safe CSS value`);
    }
  }
  return parsed as Record<string, string>;
}
