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
# INSTANCE_CSS_VARS={"--accent-base":"#b91c1c","--accent-subtle":"#fee2e2"}
# Comma-separated enabled module ids; unset = all registered modules enabled
# MODULES=tables,monitor,wiki
# Per-module config: MODULE_<ID>_<KEY>, e.g.
# MODULE_TABLES_TABLE_ID=10
# MODULE_WIKI_SYNC_TTL_S=300
# MODULE_WIKI_ROOT=.Collectives  # older Nextcloud installs may use Collectives
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

The container runs as the `node` user and exposes a health check on `/healthz`. `/data` holds the SQLite database (Nextcloud credentials + wiki mirror) — it is the only state.

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
INSTANCE_CSS_VARS={"--accent-base":"#b91c1c","--accent-hover":"#991b1b","--accent-subtle":"#fee2e2","--accent-subtle-fg":"#7f1d1d"}
MODULES=wiki                                       # restrict the module set per deployment
```

- `INSTANCE_NAME` — header, browser tab (the BFF rewrites `index.html`'s `<title>`), info dialog and all name-bearing strings
- `INSTANCE_TAGLINE` — login-page tagline; unset keeps the Einring default, empty string hides it
- `INSTANCE_CSS_VARS` — JSON map of `--var:value` injected as `:root{…}` into `index.html` before first paint; invalid JSON or unsafe values refuse startup. Set the full accent set (`--accent-base`, `--accent-hover`, `--accent-subtle`, `--accent-subtle-fg`, `--accent-fg`) or subtler shades will stay neutral
- `MODULES` — limits which modules the instance exposes (BFF registry is the source of truth)

The Authentik client is shared — a whitelabel instance still signs in via the same provider; use a separate provider/application only if the brand needs its own IdP entry. The Android app's identity (`de.wit.einring`, icon) is **not** whitelabeled — branded mobile builds would need a separate Capacitor package.

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
| BFF refuses to start with "Unknown module" | `MODULES` lists an id that isn't registered; check `GET /api/modules` names (`tables`, `monitor`, `wiki`) |
