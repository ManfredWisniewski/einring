import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  /**
   * Named biti theme: loads `themes/<name>.json` ({"light":{...},"dark":{...}} maps of
   * einring CSS variables) shipped with the BFF; injected into index.html per color scheme.
   */
  INSTANCE_THEME: z
    .string()
    .regex(/^[a-z0-9-]+$/i, "must be a theme name like 'wuttke'")
    .optional(),
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

/** A named theme: einring CSS variable maps per color scheme. */
export interface ThemeVars {
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

type BaseConfig = Omit<z.infer<typeof schema>, "MODULES" | "INSTANCE_CSS_VARS" | "INSTANCE_THEME">;

export interface Config extends BaseConfig {
  /** Parsed + validated INSTANCE_CSS_VARS, or undefined when unset. */
  INSTANCE_CSS_VARS?: Record<string, string>;
  /** Loaded + validated theme file for INSTANCE_THEME, or undefined when unset. */
  INSTANCE_THEME?: ThemeVars;
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
  const { MODULES, INSTANCE_CSS_VARS, INSTANCE_THEME, ...rest } = result.data;
  const cssVars = parseCssVars(INSTANCE_CSS_VARS);
  const theme = loadTheme(INSTANCE_THEME);
  const moduleEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([k, v]) => /^MODULE_[A-Z0-9]+_[A-Z0-9_]+$/.test(k) && typeof v === "string",
    ),
  ) as Record<string, string>;
  return {
    ...rest,
    INSTANCE_CSS_VARS: cssVars,
    INSTANCE_THEME: theme,
    modules: MODULES?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    moduleEnv,
  };
}

const THEMES_DIR = resolve(import.meta.dirname, "../themes");

type Fail = (msg: string) => never;

function validateVarMap(parsed: unknown, fail: Fail): Record<string, string> {
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

function parseCssVars(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const fail: Fail = (msg) => {
    throw new Error(`Invalid configuration:\n  INSTANCE_CSS_VARS: ${msg}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("must be a JSON object");
  }
  return validateVarMap(parsed, fail);
}

/** Loads `themes/<name>.json` — the resolved var maps of a biti theme. */
function loadTheme(name: string | undefined): ThemeVars | undefined {
  if (name === undefined) return undefined;
  const fail: Fail = (msg) => {
    throw new Error(`Invalid configuration:\n  INSTANCE_THEME: ${msg}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(THEMES_DIR, `${name}.json`), "utf8"));
  } catch (err) {
    fail(
      err instanceof SyntaxError ? "theme file is not valid JSON" : `no theme file for "${name}"`,
    );
  }
  const { light, dark } = validateVarMapTopLevel(parsed, fail);
  const theme: ThemeVars = {};
  const ctx = (label: string): Fail => {
    return (msg) => fail(`${label}: ${msg}`);
  };
  if (light !== undefined) theme.light = validateVarMap(light, ctx("light"));
  if (dark !== undefined) theme.dark = validateVarMap(dark, ctx("dark"));
  return theme;
}

function validateVarMapTopLevel(parsed: unknown, fail: Fail): Record<string, unknown> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("theme file must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
