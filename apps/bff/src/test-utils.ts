import { randomBytes } from "node:crypto";
import { type AppDeps, buildApp } from "./app.js";
import type { AuthUser } from "./auth.js";
import { loadConfig } from "./config.js";
import { createSecretBox } from "./crypto.js";
import { openStore } from "./db.js";
import type { Fetch } from "./nextcloud/client.js";

export const TEST_USER: AuthUser = { sub: "user-1", name: "Frodo", email: "frodo@shire.test" };
export const TOKEN = "valid-token";

export function testEnv(): Record<string, string> {
  return {
    AUTHENTIK_ISSUER: "https://auth.test/application/o/einring/",
    AUTHENTIK_CLIENT_ID: "einring-client",
    NEXTCLOUD_URL: "https://cloud.test/",
    MODULE_TABLES_TABLE_ID: "7",
    ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    STATIC_DIR: "./does-not-exist",
  };
}

export function testConfig() {
  return loadConfig(testEnv());
}

export type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export function fakeFetch(handler: FetchHandler): Fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input), init))) as Fetch;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function testApp(overrides: Partial<AppDeps> = {}) {
  const config = testConfig();
  const store = openStore(":memory:");
  const secrets = createSecretBox(config.ENCRYPTION_KEY);
  const app = await buildApp({
    config,
    store,
    secrets,
    verifyToken: async (token) => {
      if (token !== TOKEN) throw new Error("bad token");
      return TEST_USER;
    },
    fetchImpl: fakeFetch(() => json({ error: "unexpected fetch" }, 500)),
    logger: false,
    ...overrides,
  });
  return { app, store, config, secrets, auth: { authorization: `Bearer ${TOKEN}` } };
}
