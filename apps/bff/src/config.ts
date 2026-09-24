import { z } from "zod";

const schema = z.object({
  AUTHENTIK_ISSUER: z.url(),
  AUTHENTIK_CLIENT_ID: z.string().min(1),
  NEXTCLOUD_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  NEXTCLOUD_TABLES_TABLE_ID: z.coerce.number().int().positive(),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  ENCRYPTION_KEY: z.base64().refine((k) => Buffer.from(k, "base64").length === 32, {
    message: "ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
  PUBLIC_URL: z.url().default("http://localhost:5173"),
  STATIC_DIR: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  return result.data;
}
