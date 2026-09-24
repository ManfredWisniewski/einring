# Decisions

Architecture and project decisions for **einring**, recorded from the grilling session on 2026-09-17.
Each entry: decision, alternatives considered, reason. Change a decision by adding a new dated entry, not by rewriting history.

## Naming

- **D01 Project name: `einring`** – "one ring to rule them all"; fits the norse naming of related WIT projects.
- **D02 Android application ID: `de.wit.einring`**, display name **Einring**.
- **D03 Package names: `@einring/app`, `@einring/bff`, `@einring/tokens`.**

## Platform & stack

- **D04 Cross-platform stack: React + Vite + Capacitor** (alternatives: Flutter, React Native/Expo, Kotlin Multiplatform). One web codebase is the WebApp and, wrapped by Capacitor, the Android app; iOS stays possible via `npx cap add ios` on a Mac. Performance is not a driver; existing React and CSS knowledge is.
- **D05 Backend-for-frontend (BFF) from day one**, written in **TypeScript with Fastify** (alternatives: client-only; Express, NestJS, Hono). Service credentials never live on the device; single API for the app; Fastify chosen for typed, schema-validated routes with low boilerplate. The Python `.gitignore` entries stem from a separate Python backend that exposes an API to this app; that backend is not part of this repository.
- **D06 Monorepo with pnpm workspaces**: `apps/app`, `apps/bff`, `packages/tokens` (alternatives: separate repos; npm). pnpm for strict dependency resolution, faster installs and better workspace filtering.
- **D07 Node: pin current LTS (22) via `.nvmrc` and `engines`.**
- **D08 UI components: headless (Radix / React Aria) + own CSS driven by token variables** (alternatives: plain React, Ionic React). Accessible behaviour for free, visuals fully from the design tokens.
- **D09 Frontend libraries: React Router (v8, `react-router` package), TanStack Query v5, react-i18next; headless UI via `react-aria-components`; OIDC via `oidc-client-ts`.**
  - Access/refresh tokens are kept by `oidc-client-ts` in `localStorage` (web and Capacitor WebView). Moving them to a secure-storage plugin on Android is a backlog item.
- **D10 UI languages: German and English from the start** via an i18n layer.
- **D11 Lint/format: Biome** (alternative: ESLint + Prettier). Fall back to ESLint only if a required rule is missing.
- **D12 Git workflow: `main` + short-lived feature branches, conventional commits.**
- **D13 `.gitignore`: one common file for all projects** – keep the Python entries, add Node/Vite/Capacitor/Android; `.agents/` stays ignored while `skills-lock.json` is versioned.
- **D14 Shared WIT guidance lives in the `+wit-dev` submodule** (path renamed from `wit-dev`). Read `+wit-dev/README.md` and `+wit-dev/AGENTS.md` before making changes.

## Design tokens

- **D15 Tokens live in this repo (`packages/tokens`) as DTCG JSON, edited by hand**, built with **Style Dictionary v4** into CSS custom properties (alternatives: Figma/Tokens Studio export; separate shared token repo). Structured so it can be moved to a shared repo later.
- **D16 Token tiers: primitive → semantic**; component tier only when a component needs it. Light and dark are two semantic sets.
- **D17 Theme switching: system preference by default, manual override stored on device**; implemented via `data-theme` on `<html>`.

## Authentication & authorization

- **D18 Identity provider: Authentik via OIDC Authorization Code + PKCE (public client, no client secret).** Nextcloud is already behind Authentik.
- **D19 App ↔ BFF: the app sends the Authentik access token as `Authorization: Bearer`; the BFF validates the JWT statelessly against Authentik's JWKS** (alternative: BFF cookie session). Works identically in browser and Capacitor WebView.
- **D20 OIDC redirect URIs**: web `https://<host>/auth/callback` and `http://localhost:5173/auth/callback`; Android custom scheme `einring://auth/callback` (alternative: Android App Links – possible later once a public domain exists).
- **D21 One Authentik provider/application for dev and prod for now**; scopes `openid profile email`. Issuer URL and client ID live in gitignored `.env` files with a committed `.env.example`.
- **D22 Nextcloud access: Nextcloud Login Flow v2 per user, yielding an app password** (alternatives: forwarding Authentik bearer tokens to Nextcloud – would require Nextcloud's audience in the token; technical service account – bypasses Nextcloud permissions). Uses the official mechanism; users keep their own Nextcloud permissions.
- **D23 App passwords are stored in the BFF, encrypted at rest, keyed by the Authentik `sub`.** The app never sees Nextcloud credentials; the BFF proxies Nextcloud APIs and hosts the login-flow polling.
- **D24 Nextcloud connection is established lazily**: a "Connect Nextcloud" step on the first Nextcloud-backed screen, not during onboarding. The default Nextcloud login page is sufficient (it forwards to Authentik).
- **D25 Infrastructure prerequisites (reverse proxy / Authentik forward-auth)**:
  - exclude Nextcloud's Login Flow v2 endpoints (`/index.php/login/v2`, `/index.php/login/v2/poll`, `/index.php/login/v2/flow/*`) and API endpoints (`/ocs/*`, `/remote.php/*`, `/index.php/apps/tables/api/*`) from forward-auth interception where required;
  - preserve original `Host`, HTTPS scheme and proxy headers;
  - prefer Nextcloud's own SSO/OIDC integration or Login Flow over injecting Authentik credentials at the proxy layer;
  - the BFF hostname is also excluded from forward-auth (it validates JWTs itself).
  - Testing of file access, photo upload, notifications and WebDAV as recommended by Nextcloud is **out of scope** for einring.

## Data & deployment

- **D26 BFF persistence: SQLite**, app passwords encrypted (AES-256-GCM) with a server-side key from env (alternatives: Postgres, JSON file). Postgres only if the BFF ever runs multi-instance (HA, horizontal scaling, rolling deploys) – not expected for a single-node self-hosted deployment.
  - *2026-09-17 amendment*: driver is Node's built-in **`node:sqlite`** instead of `better-sqlite3`. Reason: `better-sqlite3` ships no prebuilt binary for odd Node versions and needs a C++ toolchain on Windows; `node:sqlite` has zero native dependencies. Consequence: Node >= 22.13 or >= 23.4 required; Node 23.0–23.3 is not supported because `node:sqlite` is unavailable there.
- **D27 Deployment artifact: one Docker image**; the BFF serves the web build (`dist/`) as static files and the API under `/api` (alternatives: separate nginx container). Same-origin, no CORS, and the shape a Nextcloud ExApp expects.
- **D28 Nextcloud integration path**: standalone behind the existing reverse proxy now; cheap integration via Nextcloud "External sites"; long-term intended as a **Nextcloud ExApp (AppAPI)**, which adds the AppAPI handshake to the BFF container.
- **D29 Local dev topology**: Vite dev server `:5173` proxies `/api` → Fastify `:3000`. Android via emulator (`10.0.2.2`) and physical device over LAN (`server.url` from env in `capacitor.config.ts`, never committed).
- **D30 Builds**: local Android builds on the Windows dev machine (Android Studio JDK, `ANDROID_HOME` to be set) **and** GitHub Actions. CI: lint, typecheck, test, web build, debug APK artifact. Release signing later.

## MVP scope

- **D31 First vertical slice: show one fixed Nextcloud Tables table (ID from BFF config) read-only.** Touches auth (Authentik), BFF, Nextcloud Login Flow, tokens and UI. Table browsing, filtering and other services go to the backlog.

## Backlog (not decided, parked)

- Android App Links instead of custom scheme.
- Separate Authentik clients per environment.
- Release-signed APK/AAB in CI.
- Nextcloud ExApp (AppAPI) handshake.
- iOS target.
- Table list / selection, filter and search in Tables view.
- Playwright e2e tests (see `tests.md`).
- Secure storage for OIDC tokens on Android (Capacitor secure-storage plugin).
- Extract shared API types into a `packages/shared` workspace instead of mirroring them in `apps/app/src/api/types.ts`.
- Code-splitting of the web bundle (currently one ~660 kB chunk).
