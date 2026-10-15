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

### A09 Wiki (Collectives mirror)

- The wiki module syncs Collectives' markdown files from Nextcloud into the BFF's SQLite store; the app renders the local mirror only (read-only, no writes to Nextcloud).
- Sync covers the page tree and page content; deleted pages are pruned. `POST /api/wiki/sync` refreshes on demand and `GET /api/wiki/tree` auto-syncs when the cache is stale (`MODULE_WIKI_SYNC_TTL_S`).
- The UI offers navigation by collective and page and full-text search over titles and content (DE + EN).
- Without Collectives installed (404 on the `Collectives` folder), sync reports zero pages and the UI shows a localized empty state — no crash.
- All wiki endpoints require auth and return 424 while Nextcloud is disconnected; no credentials or tokens appear in responses.
