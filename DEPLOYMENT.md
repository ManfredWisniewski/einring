# Deploying einring

Einring ships as a single Docker image: the Fastify BFF serves the API under `/api` and the built web app as static files. One container, one volume, no external services besides Authentik and Nextcloud.

## Prerequisites

- A Docker host with a public hostname and TLS (e.g. `https://einring.example.com`)
- An **Authentik OAuth2/OIDC provider + application** for einring (see "Authentik setup" in `README.md`). Required provider settings:
  - Client type: **Public**, grant: **Authorization Code** (+ PKCE)
  - Redirect URI: `https://<your-host>/auth/callback`
  - Signing key assigned (the BFF validates JWTs against the provider's JWKS — a keyless provider returns an empty JWKS and every API call fails with 401)
  - Scopes: `openid profile email`
- A reachable **Nextcloud** instance (`NEXTCLOUD_URL`); app passwords are obtained per user via Login Flow v2 at runtime

## 1. Get the image

### From CI (default)

`.github/workflows/build.yml` builds and pushes `ghcr.io/manfredwisniewski/einring` to GHCR on every push to `main`, every `v*` tag, and manual dispatch — `linux/amd64` + `linux/arm64`, tagged by commit SHA (plus the tag name for releases).

The workflow needs two repository **variables** (Settings → Secrets and variables → Actions → *Variables*, not secrets — they are public OIDC config baked into the web bundle):

| Variable | Value |
|---|---|
| `VITE_AUTHENTIK_ISSUER` | `https://auth.example.com/application/o/einring/` |
| `VITE_AUTHENTIK_CLIENT_ID` | the provider's client ID |

Then on the Docker host (GHCR login only needed while the package is private):

```bash
docker pull ghcr.io/manfredwisniewski/einring:sha-<commit>
# or a release tag: ghcr.io/manfredwisniewski/einring:v1.0.0
```

### Local build (alternative)

```bash
docker build -t einring \
  --build-arg VITE_AUTHENTIK_ISSUER=https://auth.example.com/application/o/einring/ \
  --build-arg VITE_AUTHENTIK_CLIENT_ID=<provider-client-id> \
  .
```

The issuer must be the provider's exact **OpenID Configuration Issuer**, normally ending in `/application/o/<slug>/`. If Authentik or the client ID ever changes, the image must be rebuilt — `VITE_*` values are compiled in.

## 2. Prepare the environment file

Create an env file on the host (never commit it):

```dotenv
# --- required ---------------------------------------------------------------
AUTHENTIK_ISSUER=https://auth.example.com/application/o/einring/
AUTHENTIK_CLIENT_ID=<provider-client-id>
NEXTCLOUD_URL=https://cloud.example.com
# 32 bytes, base64 — encrypts stored Nextcloud app passwords in the volume.
# Generate: openssl rand -base64 32
ENCRYPTION_KEY=
# Public origin of the app as browsers see it (allow-listed for CORS)
PUBLIC_URL=https://einring.example.com

# --- optional ---------------------------------------------------------------
# Whitelabel: per-deployment branding, no rebuild needed (D37)
# INSTANCE_NAME=Einring              # header, browser tab, info dialog
# INSTANCE_TAGLINE=                  # unset = app default; "" hides the tagline
# INSTANCE_THEME=wuttke              # named biti theme (apps/bff/themes/<name>.json)
# INSTANCE_CSS_VARS={"--accent-base":"#b91c1c","--accent-subtle":"#fee2e2"}
# Comma-separated enabled module ids; unset = all registered modules enabled
# MODULES=einhub,tables,monitor,wiki,csv-manager,einchat,yamtrack,audiobookshelf,navidrome,trek,email,gotify,gitlab,github
# Per-module config: MODULE_<ID>_<KEY>, e.g.
# MODULE_TABLES_APPLICATION_ID=3  # Tables application (context) id — from its /app/<id> URL;
#                                 # the module lists the application's views/tables and edits
#                                 # rows through them. Requires the Nextcloud Tables app.
# MODULE_WIKI_SYNC_TTL_S=300
# MODULE_WIKI_ROOT=.Collectives  # older Nextcloud installs may use Collectives
# MODULE_CSV_MANAGER_MAX_BYTES=5242880  # import body limit (default 5 MiB)
# MODULE_CSV_MANAGER_MAX_ROWS=20000
# Shared LLM provider (D41) — powers wiki Q&A and EinChat; unset = both disabled
# LLM_URL=https://openrouter.ai/api/v1
# LLM_API_KEY=sk-or-...       # required by OpenRouter; local servers ignore it
# LLM_CHAT_MODEL=google/gemini-2.5-flash
# LLM_EMBED_MODEL=openai/text-embedding-3-small
# LLM_TOP_K=8                 # wiki: chunks per answer prompt
# LLM_TIMEOUT_S=60
# MODULE_YAMTRACK_URL=        # optional default instance for the connect form
# MODULE_AUDIOBOOKSHELF_URL=  # same for the other connectors
# MODULE_NAVIDROME_URL=
# MODULE_TREK_URL=
# MODULE_EMAIL_URL=           # default IMAP server, e.g. imaps://imap.example.com:993
# MODULE_GOTIFY_URL=          # default Gotify server, e.g. https://push.example.com
# MODULE_GITLAB_URL=          # default GitLab instance, e.g. https://gitlab.example.com
# MODULE_GITHUB_URL=          # default GitHub instance, e.g. https://github.com or a GHES host
# MODULE_EINHUB_REFRESH_SECONDS=60  # min seconds between upstream notification polls per user
LOG_LEVEL=info
```

Do **not** set `PORT`/`HOST`/`DATA_DIR`/`STATIC_DIR` in this file — the image pins them (`PORT=3000`, `DATA_DIR=/data`, `STATIC_DIR=/srv/web`).

## 3. Run

```bash
docker volume create einring-data

docker run -d --name einring \
  -p 3000:3000 \
  --env-file .env \
  -v einring-data:/data \
  --restart unless-stopped \
  ghcr.io/manfredwisniewski/einring:sha-<commit>
```

The container runs as the `node` user and exposes a health check on `/healthz`. `/data` holds the SQLite database (Nextcloud credentials, wiki mirror, csv-manager files) — it is the only state.

### docker-compose equivalent

```yaml
services:
  einring:
    image: ghcr.io/manfredwisniewski/einring:v1.0.0   # or sha-<commit>
    ports:
      - "3000:3000"
    env_file: .env
    volumes:
      - einring-data:/data
    restart: unless-stopped

volumes:
  einring-data:
```

## 4. TLS / reverse proxy

The container speaks plain HTTP — terminate TLS in front of it (required; OIDC redirect URIs and CORS origins are HTTPS). Any proxy works; it only needs to forward `Host` and the standard headers:

```nginx
server {
    listen 443 ssl;
    server_name einring.example.com;
    # ssl_certificate ... (e.g. certbot)

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Everything is same-origin — the web app, `/api`, and `/healthz` all live on the public URL, so no path splitting or CORS configuration is needed beyond `PUBLIC_URL` matching the public origin exactly.

## 5. Verify

```bash
curl -fsS https://einring.example.com/healthz          # -> 200
curl -s -o /dev/null -w "%{http_code}\n" \
  https://einring.example.com/api/me                   # -> 401 (auth required)
```

Then open `https://einring.example.com`, sign in via Authentik, and connect Nextcloud under Settings (the app walks through Nextcloud Login Flow v2 — a browser redirect to approve, no manual password entry).

## Whitelabel deployments

One image can run multiple branded instances — branding is runtime env, not build config. These vars go in the container's env file (step 2, passed via `docker run --env-file` or `env_file:` in compose) — one file per branded deployment, all running the same image. Nothing is set in `apps/app/.env.local` or the CI build args:

```dotenv
INSTANCE_NAME=Acme Portal
INSTANCE_TAGLINE=                                  # empty hides the login-page tagline
INSTANCE_THEME=wuttke                              # named biti theme; unset = einring palette
INSTANCE_CSS_VARS={"--accent-base":"#b91c1c","--accent-hover":"#991b1b","--accent-subtle":"#fee2e2","--accent-subtle-fg":"#7f1d1d"}
MODULES=wiki                                       # restrict the module set per deployment
```

- `INSTANCE_NAME` — header, browser tab (the BFF rewrites `index.html`'s `<title>`), info dialog and all name-bearing strings
- `INSTANCE_TAGLINE` — login-page tagline; unset keeps the Einring default, empty string hides it
- `INSTANCE_THEME` — named biti theme shipped with the image (`apps/bff/themes/<name>.json`, today: `wuttke`); injected per color scheme into `index.html`. Unknown names or malformed files refuse startup
- `INSTANCE_CSS_VARS` — JSON map of `--var:value` injected as `:root{…}` into `index.html` before first paint; emitted after the theme, so explicit overrides win. Set the full accent set (`--accent-base`, `--accent-hover`, `--accent-subtle`, `--accent-subtle-fg`, `--accent-fg`) or subtler shades will stay neutral
- `MODULES` — limits which modules the instance exposes (BFF registry is the source of truth)

The SPA gets its Authentik issuer/client-id from `GET /api/config` at runtime, so each container uses its own `AUTHENTIK_ISSUER`/`AUTHENTIK_CLIENT_ID` env — the `VITE_AUTHENTIK_*` build args are only a fallback. A whitelabel instance can therefore sign in via its own Authentik provider on the same image. The Android app's identity (`de.wit.einring`, icon) is **not** whitelabeled — branded mobile builds would need a separate Capacitor package.

## Wiki LLM Q&A (Ask the wiki)

The wiki module can answer questions over the mirrored Collectives pages via retrieval-augmented generation (D39): the BFF chunks mirrored pages into `wiki_chunks`, embeds them through the configured provider, and on `POST /api/wiki/ask` sends the top-k matching chunks plus the question to the chat model. The answer carries source links into the wiki tree.

Config is all-or-nothing — the feature enables when `LLM_URL`, `LLM_CHAT_MODEL` and `LLM_EMBED_MODEL` are set; unset, the Ask UI stays hidden and the endpoints answer 424. Any OpenAI-compatible `/v1` endpoint works:

```dotenv
# Managed provider (default path): OpenRouter
LLM_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_CHAT_MODEL=google/gemini-2.5-flash
LLM_EMBED_MODEL=openai/text-embedding-3-small

# Local alternative — same code path, no API key needed
# (e.g. a llama-server or Ollama sidecar on the docker network)
# LLM_URL=http://llama-server:8080/v1
# LLM_CHAT_MODEL=local-model
# LLM_EMBED_MODEL=local-embed
```

- **Privacy**: with a remote provider, the retrieved wiki chunks and the question leave the deployment (to OpenRouter or the configured endpoint). Point `LLM_URL` at a local server to keep content in-house.
- The API key stays in the BFF — it is never sent to the app, same rule as Nextcloud credentials.
- Indexing runs after each successful wiki sync in the background (etag reuse means only changed pages re-embed) and on demand via the "Update index" button / `POST /api/wiki/llm/index`. `GET /api/wiki/llm/status` reports `configured`, `indexing`, `pages`, `indexedPages`, `chunks`.
- Both chat and embedding calls share `LLM_URL` — the provider must offer `/chat/completions` **and** `/embeddings` (OpenRouter: pick an embedding model from its limited set; llama.cpp serves both).
- Answers are stateless single-turn and non-streaming; sources cite page paths from the mirror.

## EinChat (chat with module tools)

EinChat is a multi-turn chat page (`/einchat`) where the LLM can call *tools* that enabled provider modules lend it (D41). `POST /api/einchat/message` takes the whole client-side history (`{messages: [{role:"user"|"assistant", content}]}` — stateless, like wiki ask) and returns `{reply}` after a tool-call loop capped at 5 rounds. `GET /api/einchat/status` reports `configured` and the tool names currently offered.

- EinChat shares the global `LLM_*` config — a chat model with tool-calling support is required (OpenRouter: most models; Haiku works).
- Modules expose tools via the BFF's `chatTools` capability; tools from disabled modules are simply absent. Users can toggle providers per-module in the chat's **Data connections** panel (`GET`/`PUT /api/einchat/tools`, persisted in `module_settings`) — disabled tools never reach the model.
- **Privacy**: chat messages *and* tool results (which contain the user's data) go to the configured LLM provider.

### Connector modules

Connectors share one pattern (D41): each user links their own account in the app at `/<service>`; the BFF verifies the credential against the instance, then stores it sealed in `service_credentials` — secrets never reach the app, the LLM, or other users' sessions. `MODULE_<ID>_URL` optionally prefills the instance URL. All connectors answer `not_connected` from their tools until the user links an account.

| Module | Credential | Tools for EinChat |
|---|---|---|
| `yamtrack` | API token (Settings → Integrations) | `yamtrack_search_media` (title search → watched/completed status — "have I watched X?"), `yamtrack_list_media` |
| `wiki` | none (uses the wiki index) | `wiki_search` (top-k chunks from the user's indexed collectives) |
| `audiobookshelf` | API token (Settings → Users → API Token) | `audiobookshelf_search` (library search → listening progress), `audiobookshelf_in_progress` |
| `navidrome` | username + password (Subsonic token auth) | `navidrome_search` (artists/albums/songs), `navidrome_albums` (newest/recent/starred/random) |
| `trek` | API key `trek_…` (Settings → Integrations → API Keys) | `trek_list_trips`, `trek_trip_details`, `trek_bucket_list` |
| `email` | IMAP username + password + server (`imaps://host:993` or bare host; the `url` field accepts non-HTTP addresses via the connector's `parseUrl` override) | `email_recent`, `email_read` — plus its own `/email` page listing the last 5 inbox mails with expandable bodies |
| `gotify` | username + password — a client token is minted upstream (`POST /client`) and stored instead of the password; disconnect deletes the client | `gotify_recent_messages`, `gotify_applications` — plus `/gotify`: live message stream (WS→SSE proxy), priority/app view, delete one/all, application management |

## Embedded in Nextcloud (External sites)

The app can run inside a Nextcloud **External sites** iframe — Authentik login is skipped and connecting Nextcloud doubles as sign-in:

1. In Nextcloud: **Administration settings → External sites**, add an entry pointing at
   `https://<einring-host>/?embedded=nextcloud` (the `?embedded=nextcloud` query parameter is what flips the app into embedded mode).
2. Users open the entry inside Nextcloud, land directly on "Connect Nextcloud", approve once — done. Subsequent loads reuse the stored credential.
3. The BFF automatically allows framing by the configured `NEXTCLOUD_URL` origin (`Content-Security-Policy: frame-ancestors` on the served `index.html`).

How it works: the anonymous login flow is keyed by a random `flow` id; when it completes, the BFF mints an opaque session token (`nc:<loginName>` identity, 30-day expiry, stored hashed) that the app sends as `Bearer` for all API calls. The Nextcloud app password still never leaves the BFF. The `?embedded` flag lives in sessionStorage, so it can't leak into a standalone tab of the same deployment.

## Updating

Push to `main` (or tag `v*`) — CI publishes a new image. Then on the host:

```bash
docker pull ghcr.io/manfredwisniewski/einring:sha-<new-commit>
docker stop einring && docker rm einring
docker run -d --name einring -p 3000:3000 --env-file .env \
  -v einring-data:/data --restart unless-stopped \
  ghcr.io/manfredwisniewski/einring:sha-<new-commit>
```

With compose it's `docker compose pull && docker compose up -d` after bumping the tag. SQLite schema changes are created/migrated idempotently at startup; the volume survives rebuilds.

## Backup

Everything worth keeping is in the volume:

```bash
docker run --rm -v einring-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/einring-data.tar.gz -C /data .
```

Restoring into a fresh deployment requires the **same `ENCRYPTION_KEY`** — sealed app passwords are undecryptable otherwise. Keep the key in your password manager; losing it means every user must reconnect Nextcloud.

## Android builds against a deployed BFF

The Docker image is web-only. To build an Android APK that talks to the deployed BFF, set `VITE_API_URL=https://einring.example.com` in `apps/app/.env.local`, then `pnpm --filter @einring/app android:sync` and build in Android Studio. The `einring://auth/callback` redirect URI must be registered in the Authentik provider.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `docker logs einring` shows `Invalid configuration` | Missing/invalid env — `ENCRYPTION_KEY` must be 32 bytes base64, `AUTHENTIK_ISSUER`/`NEXTCLOUD_URL` must be URLs |
| Every `/api` call returns 401 after login | Authentik provider has **no signing key** → JWKS is empty and JWT validation fails. Assign a certificate under the provider's *Signing Key* |
| Login redirects back but nothing loads | `PUBLIC_URL` doesn't match the browser origin (CORS), or the production redirect URI is missing in Authentik |
| Nextcloud connect flow fails | `NEXTCLOUD_URL` unreachable from the container, or a forward-auth layer intercepts Nextcloud's API paths (D25) |
| 424 on module endpoints | Expected when the user hasn't connected Nextcloud yet — not an error |
| BFF refuses to start with "Unknown module" | `MODULES` lists an id that isn't registered; check `GET /api/modules` names (`tables`, `monitor`, `wiki`, `csv-manager`) |
