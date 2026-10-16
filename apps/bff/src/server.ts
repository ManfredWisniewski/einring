import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createAuthentikVerifier, createCompositeVerifier, createSessionVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { createSecretBox } from "./crypto.js";
import { openStore } from "./db.js";

const config = loadConfig();
const store = openStore(resolve(config.DATA_DIR, "einring.sqlite"));
const app = await buildApp({
  config,
  store,
  secrets: createSecretBox(config.ENCRYPTION_KEY),
  // Authentik JWTs (standalone) or einring session tokens (embedded) — see D19 amendment.
  verifyToken: createCompositeVerifier(
    await createAuthentikVerifier(config.AUTHENTIK_ISSUER, config.AUTHENTIK_CLIENT_ID),
    createSessionVerifier(store.getSessionSub),
  ),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    store.close();
    process.exit(0);
  });
}

await app.listen({ port: config.PORT, host: config.HOST });
