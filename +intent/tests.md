# Test strategy

## Principles

- Every feature gets acceptance criteria here **before** implementation; a feature is done when they pass.
- Unit tests with **Vitest** in `apps/app` (React Testing Library) and `apps/bff` (Fastify `inject`).
- End-to-end tests with **Playwright** against the web build are added once the first flow is stable (backlog).
- Android instrumentation tests are not planned.
- CI (GitHub Actions) runs lint, typecheck and all unit tests on every push and pull request.

## Acceptance criteria

### A01 Authentik login

- Unauthenticated user opening the app sees a login screen.
- `GET /api/config` serves the deployment's `authentik.issuer`/`authentik.clientId` without auth; the SPA builds its OIDC manager only after that fetch resolves and prefers those values over the baked `VITE_AUTHENTIK_*` ones, so one image works with different Authentik providers.
- Login redirects to Authentik (Authorization Code + PKCE) and returns to `/auth/callback` (web) or `einring://auth/callback` (Android).
- After login the app shows the user's display name.
- Access token is sent as `Authorization: Bearer` to the BFF; BFF rejects missing, expired or wrongly-signed tokens with `401`.
- Logout clears local tokens.

### A02 Connect Nextcloud (Login Flow v2)

- A Nextcloud-backed screen without a stored app password shows "Connect Nextcloud".
- Tapping it opens the Nextcloud login page in the system browser / new tab; completing it stores the app password in the BFF, encrypted, keyed by the Authentik `sub`.
- The app password is never returned to the client.
- Re-opening the screen after connecting shows data without a second login.

### A03 Nextcloud Tables – fixed table read-only (MVP)

- BFF exposes `GET /api/tables/current` returning columns and rows of the configured table ID.
- App renders columns as headers and rows as a scrollable table/list, in light and dark theme, in DE and EN.
- Loading and error states are visible.

### A04 Design tokens

- `packages/tokens` builds without errors; the CSS output contains both light and dark variable sets.
- No hard-coded colours, spacing or font sizes in component CSS – only token variables.

### A05 Builds

- `pnpm build` produces the web build; `pnpm --filter @einring/app cap sync android` succeeds; debug APK installs on emulator and device.
- GitHub Actions produces the debug APK artifact.

### A06 App information

- The authenticated layout shows an accessible info button in the top-right app bar.
- Activating it opens a localized information popover in German and English.
- The popover can be closed with its close button, Escape, or outside interaction, and focus returns to the info button.

### A07 Module framework

- `GET /api/modules` returns the enabled module set from `MODULES` env; disabling a module removes its BFF routes (404) and its app route + nav entry.
- Per-module env `MODULE_<ID>_*` is validated at BFF startup; invalid config of an enabled module fails fast; a disabled module's invalid config does not.
- A frontend-only module can be enabled without a BFF part.
- A module requiring `nextcloud` shows the connect card instead of its content while the service is disconnected.
- Module labels and strings exist in DE + EN; theme tokens only.

### A08 Nextcloud Monitor

- "Server" view shows Nextcloud server health (load, memory, disk, update status) proxied via the serverinfo OCS endpoint; a missing serverinfo app produces a visible, localized error state, not a crash.
- "Talk" view lists user statuses, searchable and filterable by group; if the connected account lacks the provisioning scope the fallback behaviour is implemented and documented.
- Each Talk status row ends with the user's "last seen" timestamp (`lastLogin` from the provisioning API, exposed as `lastSeenAt` epoch ms): relative within the last week, absolute date beyond that, localized (DE + EN). Without provisioning access or for never-logged-in accounts it renders as "—".

### A09 Wiki (Collectives mirror)

- The wiki module syncs Collectives' markdown files from Nextcloud into the BFF's SQLite store; the app renders the local mirror only (read-only, no writes to Nextcloud).
- Sync covers the page tree and page content; deleted pages are pruned. `POST /api/wiki/sync` refreshes on demand and `GET /api/wiki/tree` auto-syncs when the cache is stale (`MODULE_WIKI_SYNC_TTL_S`).
- The UI offers navigation by collective and page and full-text search over titles and content (DE + EN).
- Without Collectives installed (404 on the `Collectives` folder), sync reports zero pages and the UI shows a localized empty state — no crash.
- `MODULE_WIKI_SOURCE_DIR` mirrors a local directory instead of WebDAV (basename = collective name; dot-dirs are skipped) for development seeding.
- All wiki endpoints require auth and return 424 while Nextcloud is disconnected; no credentials or tokens appear in responses.

### A10 Instance whitelabel

- `INSTANCE_NAME` sets the deployment's display name at runtime (no rebuild); it appears in the app header, browser tab (`<title>` of the served `index.html`), and name-bearing strings via `{{name}}` interpolation (DE + EN).
- `GET /api/config` exposes `name`, `tagline`, `cssVars` and `theme` without authentication; `name` defaults to `Einring` when unset.
- `INSTANCE_TAGLINE` overrides the login-page tagline; unset = app default, empty string hides it.
- `INSTANCE_THEME` selects a named theme shipped with the BFF (`apps/bff/themes/<name>.json`, e.g. `wuttke`); its `light`/`dark` variable maps are injected into `index.html` as `:root{}` + `[data-theme="dark"]{}` blocks and served via `GET /api/config` for the dev server. Unknown names, non-`--` keys or unsafe values fail config at startup.
- `INSTANCE_CSS_VARS` (JSON map of `--var:value`) is injected as a `:root{}` style block into `index.html` so branding applies before first paint; it is emitted after the theme block, so explicit overrides win. Malformed JSON, non-`--` keys or unsafe values fail config at startup.
- Whitelabel + `MODULES` compose: a deployment can run a restricted module set under a different title on the same image.

### A11 Embedded mode (Nextcloud External sites)

- Entering the app via `?embedded=nextcloud` marks the tab embedded (sessionStorage — survives SPA navigation); Authentik login is skipped and the "Connect Nextcloud" card is the sign-in.
- `POST /api/nextcloud/login-flow` without a bearer token returns `{login, flow}`; poll takes `{flow}` and pending flows expire after 10 minutes.
- Completing the poll anonymously stores the credential under `nc:<loginName>` and returns a `sessionToken`; the app stores it and sends it as `Authorization: Bearer` — it authenticates all `/api/*` routes like an Authentik JWT (`/api/me` answers the session's `sub`).
- The app password never appears in any response, including the session-minting poll response.
- A poll without `flow` gets 400; an unknown/expired `flow` gets 409.
- `DELETE /api/nextcloud/connection` removes the credential AND the user's sessions — the dead token gets 401.
- Standalone deployments (`?embedded` absent) are unchanged: Authentik login, user-scoped flows, no session minted on poll.
- The served `index.html` carries `Content-Security-Policy: frame-ancestors 'self' <NEXTCLOUD origin>` so only the configured cloud may frame the app.
