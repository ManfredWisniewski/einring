# Handoff: School module — local test setup and first run

Date: 2026-11-26 · Status: automated tests green; manual demo blocked on Authentik group setup

## Context

Goal: get the `school` module (music-school management, D56 — people, lessons,
invoicing, messaging, homework) testable locally. Module state is `dev` in
`README_Modules.md`; acceptance criteria are A32/A33 in `+intent/tests.md`.

## What was verified

- `apps/bff/src/modules/school.test.ts`: **18/18 tests pass** (Fastify inject,
  in-memory school SQLite, mocked token verifier with fake `groups` claims —
  no Authentik/Nextcloud needed).
- `pnpm dev` brings up vite :5173 + BFF :3001 (`PORT=3001` in the local `.env`;
  the :3000 in docs is the Docker pin).

## Environment findings (cost time — don't rediscover)

- Host Node is **v23.1.0** — inside the unsupported 23.0–23.3 window where
  `node:sqlite` does not exist. Everything Node-side needs
  `NODE_OPTIONS=--experimental-sqlite`, i.e.
  `NODE_OPTIONS=--experimental-sqlite pnpm dev` and the same prefix for vitest.
  Without it the BFF crashes at startup (`ERR_UNKNOWN_BUILTIN_MODULE`) and every
  sqlite-touching test file fails. Fix properly: upgrade to >= 23.4 or drop to
  >= 22.13.
- `pnpm --filter @einring/bff test -- <file>` forwards a literal `--` to vitest
  and runs the whole suite anyway. Working filter form:
  `pnpm --filter @einring/bff exec vitest run src/modules/school.test.ts`.
- Local `.env` lacks `MODULE_SCHOOL_SEED` → `POST /api/school/seed` answers 403.
  Set `MODULE_SCHOOL_SEED=1` for demo data (seed only runs on an empty school DB,
  creates persons/household/series/instrument/rental/holiday — no sub links).

## Current blocker: no school role

App shows "Kein Schulzugang — dein Konto hat keine Schulrolle". Expected —
roles come **only** from the Authentik `groups` JWT claim
(`einring-school-admin|teacher|parent|student`, overridable via
`MODULE_SCHOOL_GROUP_*`); there is no dev bypass and embedded/Nextcloud
sessions carry no groups. Two things to fix in Authentik:

1. Create the `einring-school-*` groups and add the test user(s); then
   **re-login** — group changes need a fresh token.
2. Confirm the einring OIDC provider emits `groups` (default `profile`
   scope mapping). If the claim is absent, every user stays role-less.

Verify what the BFF sees via `GET /api/me` with the browser's access token —
`groups` must list `einring-school-*`.

## Next steps for manual testing

1. Authentik: create groups, assign users, re-login → `/school` should render
   the role-aware nav.
2. Add `MODULE_SCHOOL_SEED=1` to `.env`, restart BFF, call
   `POST /api/school/seed` as an admin user.
3. Each non-admin test user must hit a school endpoint once (lands in
   `school_users`), then the admin links their `sub` to a seeded person via
   the People view — until linked, scoped views are empty.
4. Optional: `MODULE_SCHOOL_MATRIX_URL`/`MODULE_SCHOOL_MATRIX_TOKEN` for
   message delivery fan-out (inactive without).

## Reminder

`NODE_OPTIONS=--experimental-sqlite` requirement disappears once the host Node
leaves the 23.0–23.3 window; until then it's needed for `dev`, `test`, and any
direct `tsx` invocation.
