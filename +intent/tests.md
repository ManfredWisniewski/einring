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

- Superseded by A14 (D40): the module is application-scoped, not single-table.

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

### A12 CSV Manager

- `POST /api/csv-manager/files` imports a CSV document (JSON `{name, csv}`; delimiter `,`/`;`/tab auto-detected; quoted fields with `""` escapes, CRLF/LF and BOM handled). The first record becomes the header row; data rows are padded/truncated to header width. Missing name/csv, empty documents, unbalanced quotes and over-limit uploads (`MODULE_CSV_MANAGER_MAX_ROWS`, `MODULE_CSV_MANAGER_MAX_BYTES`) are rejected.
- `GET /api/csv-manager/files` lists the caller's imported files (id, name, headers, row count, createdAt); `GET /api/csv-manager/files/:id` returns headers and rows including the per-row `done` flag. Files and rows are scoped to the authenticated `sub` — another user's id answers 404.
- `PATCH /api/csv-manager/files/:id/rows/:rowId` updates a row's cells and/or `done` flag; `POST /api/csv-manager/files/:id/rows` appends a row; `DELETE` removes single rows and whole files. All endpoints require auth.
- The app lists imported files, opens one as an interactive table — per-row "done" checkbox, inline-editable cells, −/+ steppers on numeric cells, add-row and row/file delete — in DE + EN, light + dark, token variables only.
- A frontend-roundtrip works end to end: import → listed file → edited cell/done flag/add row persists on reload.

### A13 Wiki LLM Q&A (RAG over the mirror)

- When `MODULE_WIKI_LLM_URL`/`_API_KEY`/`_CHAT_MODEL`/`_EMBED_MODEL` are configured, `POST /api/wiki/llm/index` chunks the caller's mirrored pages into `wiki_chunks` (heading-aware ~1–2 kB chunks, `Float32` embedding blobs) via `POST <LLM_URL>/embeddings`; unchanged pages reuse embeddings via the sync etag. `GET /api/wiki/llm/status` reports indexed chunk/page counts and whether LLM is configured.
- `POST /api/wiki/ask {question}` embeds the question, cosine-ranks the caller's chunks, prompts `<LLM_URL>/chat/completions` with the top-k chunks (`MODULE_WIKI_LLM_TOP_K`) and returns `{answer, sources: [{path, title}]}`. Provider requests carry `Authorization: Bearer <LLM_API_KEY>` when configured; **the API key never appears in any response**.
- The system prompt instructs the model to answer only from the supplied context and to say when the context lacks the answer; an empty index produces a localized "index first / not indexed" state, not a hallucinated answer.
- All LLM endpoints require auth, are scoped to the caller's `sub`, and answer **424** when LLM config is missing (the wiki mirror itself keeps working); provider errors surface as a localized error state, not a crash. The question body is validated (non-empty, length-capped).
- The wiki module shows a localized "Ask" input (DE + EN); the answer renders through the existing marked+DOMPurify pipeline and each source links to its mirrored page. When LLM is unconfigured the Ask UI is hidden or shows the localized disabled state.

### A14 Tables application (Nextcloud Tables context)

- With `MODULE_TABLES_APPLICATION_ID` set, `GET /api/tables` returns the application's name and its nodes (`{type: "view"|"table", id, title}`) read via the OCS v2 contexts endpoint. Unset → 424 plus a localized not-configured state in the app; a context 404 from Nextcloud surfaces as a localized error, not a crash.
- `GET /api/tables/nodes/<view|table>/<id>` returns `{kind, id, title, emoji?, columns (id/title/type/subtype/options), rows (id + raw cell values keyed by columnId)}` — view nodes read through `/api/1/views/{id}/*` (filters/sorting applied Nextcloud-side), table nodes through `/api/1/tables/{id}/*`. Unknown node type → 400; a node missing upstream → 404.
- `PATCH /api/tables/rows/<rowId>` writes typed cell values (`{data: {columnId: value}}` → `PUT /api/1/rows/{id}`); `POST /api/tables/nodes/<type>/<id>/rows` creates a row view/table-scoped; `DELETE …/rows/<rowId>` removes it (view-scoped delete for view nodes). All endpoints require auth and answer 424 while Nextcloud is disconnected.
- The app lists the application's nodes and renders the open one as an interactive grid: `selection`+`check` columns as checkboxes (the "done" pattern), `number` cells numeric with −/+ steppers, `selection` columns with options as dropdowns, `text` inline-editable, `datetime`/`usergroup` read-only. Add/delete row controls; DE + EN, token variables only.

### A15 EinChat + connector modules

- `GET /api/einchat/status` answers `{configured, tools: [names]}` — `configured` follows the global `LLM_*` vars; `tools` lists the `chatTools` of every enabled module. `POST /api/einchat/message {messages}` runs the tool-call loop (`tool_calls` → module `call` → tool results → re-prompt, max 5 iterations) and returns `{reply}`; unconfigured → 424, provider failure → 502.
- Wiki LLM keeps working unchanged on the global `LLM_*` config (no `MODULE_WIKI_LLM_*` left); the API key never appears in any response.
- `yamtrack`: `POST /api/yamtrack/credentials` verifies the API key against Yamtrack before storing it sealed per `sub`; `GET /api/yamtrack/status` and `DELETE` work per user; stored keys never leave the BFF. Its tools answer `{error:"not_connected"}` when the caller has no credential — user A's token is never used for user B.
- The app shows `/einchat` (thread + input + busy indicator, markdown replies, DE+EN) only when `configured`, and `/yamtrack` as a minimal connect/disconnect form.
- Wiki exposes `chatTools` too: `wiki_search {query}` embeds the query and returns top-k chunks with page paths/titles; absent when `LLM_*` unset; `not_indexed` when the user has no chunks.
- Per-user tool selection (EinChat data connections): `GET /api/einchat/tools` lists every collected tool with `{name, module, enabled}` (default enabled); `PUT /api/einchat/tools {disabled: [names]}` persists per `sub`; `/message` offers only enabled tools. The EinChat page shows a connections section toggling modules; a disabled module's tools never reach the model. Selection survives across sessions (BFF-persisted).
- Every einring module may expose an EinChat connector (`chatTools`); the Data connections panel lists one entry per *enabled* module that offers tools — modules disabled via `MODULES` never appear, and new modules surface automatically once they implement `chatTools`.
- Connector modules `audiobookshelf`, `navidrome`, `trek` share `yamtrack`'s credential-route shape (`GET /api/<id>/status`, `POST`/`DELETE /api/<id>/credentials` — verify-then-seal per `sub`, `MODULE_<ID>_URL` as optional default). Audiobookshelf tools return library matches with listening progress; Navidrome authenticates via Subsonic token (salted md5 — the stored password never appears on the wire) and returns artists/albums/songs; Trek uses `trek_` API keys and returns trips/itineraries. Each app module is the shared connect form (apiKey or username+password variant), DE + EN.
