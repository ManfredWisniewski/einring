// Demo launcher for the einchat-mcp surface: real HTTP server, stubbed session
// auth (Bearer "demo-session" → a fixed user), in-memory store. Run:
//   NODE_OPTIONS=--experimental-sqlite pnpm exec tsx scripts/demo-mcp.ts
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createSecretBox } from "../src/crypto.js";
import { openStore } from "../src/db.js";

const config = loadConfig({
  AUTHENTIK_ISSUER: "https://auth.test/application/o/einring/",
  AUTHENTIK_CLIENT_ID: "einring-client",
  NEXTCLOUD_URL: "https://cloud.test/",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  STATIC_DIR: "./does-not-exist",
});
const store = openStore(":memory:");
const app = await buildApp({
  config,
  store,
  secrets: createSecretBox(config.ENCRYPTION_KEY),
  verifyToken: async (token) => {
    if (token !== "demo-session") throw new Error("bad token");
    return { sub: "demo-user", name: "Demo", email: "demo@test" };
  },
});
await app.listen({ port: 3999, host: "127.0.0.1" });
console.log("demo BFF on http://127.0.0.1:3999 — session token: demo-session");
