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
