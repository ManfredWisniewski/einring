# einring

*One ring to control them all.* A mobile/web UI that manages services through their APIs, signed in via Authentik (OIDC), starting with Nextcloud Tables. The name is the norse-flavoured "one ring" from Tolkien, in line with other WIT projects.

## AI folders

Before making changes, read the shared WIT development guidance in `+wit/development/` in this repository. Start with `+wit/development/README.md` and `+wit/development/AGENTS.md`, then read the relevant convention or best-practice files. These shared definitions apply independently of which skill or AI agent is performing the work.

- `/+intent` — purpose, decisions and acceptance criteria of this repository
- `/+wit` — submodule, shared knowledge: research, plans, templates and domain standards (`development/` for this project)
- `/+team` — per-persona task files and shared coordination logs

## Contents

| Path | Purpose |
|------|---------|
| `apps/app` | React + Vite UI; wrapped by Capacitor for Android (`de.wit.einring`) |
| `apps/bff` | Fastify backend-for-frontend: validates Authentik JWTs, holds Nextcloud app passwords, proxies APIs, serves the web build |
| `packages/tokens` | Design tokens (DTCG JSON) built with Style Dictionary into CSS variables |
| `+intent` | Project intent, decisions and test strategy |
| `+team/+tasks` | Per-persona task files; `backlog.md` is the human-owned parking lot |
| `priorities.md` | Owner-written direction for agents |

## Repository setup

Branches (`main`, `work`, `wip`, one per persona) and submodules follow `+wit/common/conventions/repo-setup.md`; the agent working procedure (persona worktrees) is in `+wit/common/conventions/git-worktrees.md`.

```bash
git clone --recurse-submodules https://github.com/ManfredWisniewski/einring.git einring
cd einring
git config submodule.recurse false
git submodule update --init
```

## Prerequisites

- Node 22 LTS (>= 22.13, `node:sqlite` without flags) and pnpm 10 (`npm i -g pnpm`)
- Android: Android Studio (bundled JDK 21) and its SDK; set `JAVA_HOME` and `ANDROID_HOME`
- Authentik: a public OAuth2/OIDC provider + application "einring" (PKCE, no client secret), redirect URIs
  `http://localhost:5173/auth/callback`, `einring://auth/callback` and the production URL; scopes `openid profile email`
- Nextcloud with the Tables app; Login Flow v2 and API endpoints reachable without forward-auth interception (see `+intent/decisions.md` D25)

## Authentik setup

Create a **new Authentik application with an OAuth2/OIDC provider** for Einring. Use Authentik's combined **Applications → Applications → Create with provider** flow.

1. In Authentik Admin, open **Applications → Applications → Create with provider**.
2. Application:
   - Name: `Einring`
   - Slug: `einring`
   - Launch URL: optional; use the production web URL if desired.
3. Provider type: **OAuth2/OIDC**.
4. Configure the provider:
   - Client type: **Public**
   - Authorization flow: `default-provider-authorization-implicit-consent` for this trusted first-party app. This means Authentik does not show an extra consent screen; it does **not** mean the OAuth implicit grant.
     Use `default-provider-authorization-explicit-consent` instead if Einring will be used by independent users or you want an explicit approval screen.
   - Client ID: generate one or use `einring`; this is the value for `VITE_AUTHENTIK_CLIENT_ID`.
   - Allowed grant type: **Authorization Code** (with PKCE)
   - Redirect URI mode: **Strict**
   - Redirect URIs, each as a separate entry:
     - `http://localhost:5173/auth/callback`
     - `einring://auth/callback`
     - `https://<your-production-host>/auth/callback`
   - Scopes: `openid`, `profile`, `email` (add `offline_access` only if refresh tokens are explicitly needed).
5. Save the provider and ensure it is assigned to the `Einring` application. Access policies/groups can be configured on the application as usual.
6. Copy the provider's **OpenID Configuration Issuer** value exactly (including its trailing `/`) into `VITE_AUTHENTIK_ISSUER`. It normally looks like
   `https://<authentik-host>/application/o/einring/`.
7. Fill `apps/app/.env.local`:

   ```dotenv
   VITE_AUTHENTIK_ISSUER=https://<authentik-host>/application/o/einring/
   VITE_AUTHENTIK_CLIENT_ID=<the-provider-client-id>
   VITE_API_URL=
   ```

8. Fill the BFF's root `/.env` with the same issuer and client ID, without the `VITE_` prefix:

   ```dotenv
   AUTHENTIK_ISSUER=https://<authentik-host>/application/o/einring/
   AUTHENTIK_CLIENT_ID=<the-provider-client-id>
   ```

The client is public: no client secret belongs in either `.env` file. PKCE protects the authorization-code exchange. After changing the app `.env.local`, rebuild the web assets and APK because Vite embeds `VITE_*` values at build time:

```powershell
pnpm --filter @einring/app build
pnpm --filter @einring/app android:sync
```

The exact Authentik menu labels can vary by Authentik version. The authoritative provider documentation is [OAuth 2.0 provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/).

### Troubleshooting client authentication errors

If login reaches Authentik but returns `Client authentication failed` after the redirect, verify:

- the Authentik provider's **Client type** is `Public`, not `Confidential`;
- the client ID in `apps/app/.env.local` is the provider's generated **Client ID**, not the application slug or provider name;
- the same client ID is in the root `.env` as `AUTHENTIK_CLIENT_ID`;
- the provider allows the **Authorization Code** grant and the redirect URI matches exactly, including scheme, path and trailing slash rules;
- the configured issuer is the provider's exact **OpenID Configuration Issuer**, normally ending in `/application/o/einring/`;
- no client secret is configured or required for this public PKCE client.

The app uses Authorization Code + PKCE and sends only the client ID at the token endpoint. Therefore, this error is normally an Authentik provider/client-type or client-ID mismatch, not a missing secret in the frontend. The issuer discovery endpoint can be checked at:

```text
https://<authentik-host>/application/o/einring/.well-known/openid-configuration
```

After changing `apps/app/.env.local`, restart Vite or rebuild the app because Vite embeds `VITE_*` values at build time.

## Setup

```powershell
pnpm install
Copy-Item .env.example .env                          # BFF settings
Copy-Item apps/app/.env.example apps/app/.env.local  # public OIDC settings for the UI
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # -> ENCRYPTION_KEY
pnpm tokens:build
```

## Develop

The project also provides a small Make facade. The pnpm scripts remain the canonical commands, so Make is optional; it is useful when working across projects with the same commands.

```powershell
make install
make run             # BFF on :3000 and Vite on :5173 (proxies /api)
make test
make lint
make typecheck
make build
```

Equivalent pnpm commands:

```powershell
pnpm dev
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

Markdown lint:

```powershell
npx markdownlint-cli2 "**/*.md"
```

Android:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" # full JDK; must contain bin\jlink.exe
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
make sync                                  # build web, copy into android/
make android-open                          # open in Android Studio
# Equivalent pnpm commands:
pnpm --filter @einring/app android:sync
pnpm --filter @einring/app android:open
# live reload on a device in the same LAN:
$env:CAP_SERVER_URL = "http://<your-pc-ip>:5173"; pnpm --filter @einring/app cap sync android
```

Set `VITE_API_URL` in `apps/app/.env.local` to the BFF URL for device builds (`http://10.0.2.2:3000` on the emulator).

## Deploy

One Docker image serves API and web build:

```powershell
docker build -t einring --build-arg VITE_AUTHENTIK_ISSUER=... --build-arg VITE_AUTHENTIK_CLIENT_ID=... .
docker run -p 3000:3000 --env-file .env -v einring-data:/data einring
```

## Documentation

- `+intent/intent.md` - what and why
- `+intent/decisions.md` - architecture decisions with alternatives and reasons
- `+intent/tests.md` - test strategy and acceptance criteria
