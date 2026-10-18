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

### A16 Email module

- `email` uses the shared connector routes with IMAP credentials: `POST /api/email/credentials {username, password, url}` where `url` is the IMAP server (`imaps://host:993` or bare `host`/`host:port`); the BFF verifies by logging in before storing the secret sealed; auth failure → 401, unreachable → 502.
- `GET /api/email/list` returns the last 5 INBOX envelopes (`{uid, subject, from, date}`) for the caller's account — 424 when not connected. `GET /api/email/message/<uid>` returns the parsed body (`{subject, from, date, text, html?}`) — 404 for unknown uid. `DELETE /api/email/message/<uid>` flags `\\Deleted` + expunges — 404 for unknown uid.
- The app `/email` page shows the connect form until linked, then the 5 newest mails (sender + subject + date); tapping one expands it and loads the body inline (text/plain preferred, sanitized HTML fallback) with a delete button that removes the mail and refreshes the list. DE + EN.
- EinChat gets `email_recent` (last 5 subjects/senders) and `email_read {uid}` tools; without a credential they answer `not_connected`.

### A17 Gotify module

- `gotify` uses the shared connector routes with username+password: `POST /api/gotify/credentials` mirrors the Android app's login — it mints a **client token** upstream via `POST /client` (Basic auth) and stores only `{token, clientId}` sealed per `sub`; the password is never stored. `MODULE_GOTIFY_URL` may preset the instance URL. `DELETE /api/gotify/credentials` removes the upstream client (`DELETE /client/<id>`, best-effort) before dropping the local row.
- `GET /api/gotify/messages?limit=` returns the newest messages (`{id, appId, title, message, date, priority, contentType}` — `contentType` lifted from `extras["client::display"]`); `GET /api/gotify/applications` lists apps (`{id, name, description, token}`) so senders can be configured; `POST /api/gotify/applications {name, description?}` creates an app and returns its token; `DELETE /api/gotify/messages/<id>` and `DELETE /api/gotify/messages` remove one / all messages; `DELETE /api/gotify/applications/<id>` removes an app. All upstream calls use the client token (`X-Gotify-Key`); everything answers 424 when not connected, upstream auth loss maps to 401, unreachable to 502.
- `GET /api/gotify/stream` is an SSE endpoint: the BFF opens the upstream WebSocket `/stream?token=` and forwards each message frame — the client token never reaches the browser (EventSource can't send `Authorization`). The app merges streamed messages into the live list.
- The app `/gotify` page shows the shared connect form until linked, then the message list (app name, priority dot, title, time), expandable to a rendered body (markdown when `contentType` is `text/markdown`, plain otherwise, sanitized), with per-message delete and a delete-all action, plus an applications section (list with token, create, delete) — localized DE + EN + RU + FR.
- EinChat gets `gotify_recent_messages {limit?}` and `gotify_applications` tools; without a credential they answer `not_connected`.

### A18 EinHub (notification hub, default module)

- `einhub` is the first module: first nav entry and the app index route (`/` redirects to `/einhub`). Like every module it is gated by `MODULES` — when disabled, the next module takes the index slot.
- `BffModule` may expose `notifications(ctx, config)` → `{poll(sub)}` returning recent upstream items `{sourceId, title, body?, at?}`; disconnected or failing sources return `[]` — a broken source never breaks the hub.
- `GET /api/einhub/notifications` refreshes all enabled sources for the caller — throttled to `MODULE_EINHUB_REFRESH_SECONDS` (default 60) per `sub` — and answers `{notifications, unread}` newest-first. Items dedupe per user via `UNIQUE(sub, module, source_id)`; the first poll of a module seeds its items as **read** history (no alert storm on first connect).
- `POST /api/einhub/notifications/<id>/read` marks one notification read (404 for foreign/unknown ids); `POST /api/einhub/read-all` marks all of the caller's notifications read.
- `gotify` feeds pushed messages (sourceId = upstream message id, title/body/priority time); `email` feeds new INBOX envelopes (sourceId = uid). Both reuse their sealed per-user credentials — notification content reaches only the owning `sub`.
- The `/einhub` page lists notification cards (module name, title, body, time; unread highlighted) with a mark-all-read action; tapping a card marks it read and links to the source module page when that module is enabled. An Unread/All toggle next to the title defaults to **Unread** (read items hidden); **All** shows the newest 20 items including read ones. The nav entry carries an unread-count badge that updates while any page is open. DE + EN + RU + FR.
- EinChat gets an `einhub_notifications` tool listing the caller's recent notifications.

### A19 GitLab module (connector + notifications)

- `gitlab` uses the shared connector routes with a personal access token: `POST /api/gitlab/credentials {apiKey, url}`; the BFF verifies via `GET /api/v4/user` (`PRIVATE-TOKEN` header) before sealing per `sub`; auth failure → 401, unreachable → 502. `MODULE_GITLAB_URL` may preset the instance.
- `GET /api/gitlab/todos?limit=` returns the caller's pending GitLab todos (`{id, project, author, action, targetType, title, url, createdAt}`) — GitLab's API-side notification surface; 424 unconnected, 401 token rejected, 502 unreachable.
- `gitlab` exposes a `notifications` source (D42): pending todos become einhub items (`sourceId` = todo id, title = `<action>: <target title>`, body = `project · author`), so new assignments/mentions/failed pipelines surface in EinHub and the nav badge.
- The `/gitlab` page shows the shared connect form until linked, then the pending-todo list (action, title, project, time) linking to the upstream `target_url`; DE + EN + RU + FR.
- EinChat gets a `gitlab_todos` tool; without a credential it answers `not_connected`.

### A20 GitHub module (connector + notifications)

- `github` uses the shared connector routes with a personal access token: `POST /api/github/credentials {apiKey, url}`; `url` is the instance web URL (`https://github.com` default or a GHES host) — the BFF maps it to the REST base (`api.github.com` / `<host>/api/v3`). Verify via `GET /user` before sealing per `sub`; auth failure → 401, unreachable → 502. `MODULE_GITHUB_URL` may preset an instance.
- `GET /api/github/notifications?limit=` returns the caller's notification threads (`{id, unread, reason, title, type, repo, url, updatedAt}`); `url` is the web link (derived from the API subject URL). 424 unconnected, 401 token rejected, 502 unreachable.
- `github` exposes a `notifications` source (D42): notification threads become einhub items (`sourceId` = thread id, title = `<reason>: <subject title>`, body = `repo · type`), so mentions/review requests/CI results surface in EinHub and the nav badge.
- The `/github` page shows the shared connect form until linked, then the unread-thread list (reason, title, repo, time) linking to the upstream subject; DE + EN + RU + FR.
- EinChat gets a `github_notifications` tool; without a credential it answers `not_connected`.

### A21 Authentik module (connector + monitoring surface)

- `authentik` uses the shared connector routes with an API token: `POST /api/authentik/credentials {apiKey, url}`; `url` is the instance web URL (`MODULE_AUTHENTIK_URL` may preset it). Verify via `GET /api/v3/core/users/me/` (Bearer) before sealing per `sub`; auth failure → 401, unreachable → 502.
- `GET /api/authentik/status` returns an aggregate health snapshot `{account, version, counts, workers, tasks, events, fetchedAt}` assembled from best-effort `/api/v3` probes: `/admin/version`, `pagination.count` of users/groups/applications/outposts, `/admin/system_tasks`, `/admin/workers`, and the latest `/events/events`. Each probe degrades to `null` on 401/403/404 or failure — a non-admin token yields a partial status, never a wholesale 5xx; 424 unconnected, 502 when every probe fails.
- The Monitor page gains an **Authentik tab** (only while the `authentik` module is enabled) that renders the status — version/outdated, counts, workers, failed system tasks, recent events; when the module is enabled but not connected it links to `/authentik` instead.
- The `/authentik` page is primarily the connect/config surface (shared form until linked, then connected state + disconnect + the same status view); DE + EN + RU + FR.
- EinChat gets an `authentik_status` tool returning the same aggregate; without a credential it answers `not_connected`.

### A22 Nextcloud module (feature configuration)

- `nextcloud` (BFF, `requires: ["nextcloud"]`) stores per-user Nextcloud feature preferences in `module_settings` under `{"monitorTalk","monitorServer","tables","wiki"}` — all default `true` when unset.
- `GET /api/nextcloud/settings` returns `{settings}` merged with defaults; `PUT /api/nextcloud/settings` accepts a partial boolean map, merges it, persists, and returns the merged settings. Unknown keys rejected with 400; settings are scoped per `sub`.
- The `/nextcloud` page (inside the Nextcloud gate) shows the connection state and a checkbox per feature: Monitor Talk tab, Monitor server statistics, Tables, Wiki. Toggling saves immediately; DE + EN + RU + FR.
- The Monitor page honours `monitorTalk`/`monitorServer`: a disabled tab is not rendered; when both are off and no Authentik module is enabled the page shows a hint linking to `/nextcloud`.
- Disabling `tables` or `wiki` hides that module's nav entry for the user (a personal-preference filter — the routes stay reachable, the BFF endpoints keep working; EinChat tool control stays with the einchat data-connections UI).

### A23 Module activation menu (per-user integration selection)

- `settings` (BFF) stores the caller's disabled-module set in `module_settings` as `{disabled: string[]}`. `GET /api/settings/modules` returns `{disabled}`; `PUT /api/settings/modules` replaces it — 400 on non-string entries, unknown module ids, or `einhub` (index route, must stay enabled).
- The app header gains a hamburger menu where the info button was, with items **Modules** and **Info**; Info opens the existing popover content, Modules opens a dialog listing every BFF-enabled module (except einhub) with a checkbox — unchecking adds the id to the caller's disabled set; DE + EN + RU + FR.
- A disabled module disappears from the nav for that user (merged with the D46 nextcloud feature toggles), its EinHub notifications are filtered out of the displayed feed, and the Monitor Authentik tab hides when `authentik` is disabled. Routes and BFF endpoints keep working — preference-level filtering, not authorization (same as D46); server-side enablement stays `MODULES`.
- Re-enabling restores the module's nav entry and its previously collected EinHub items (the feed keeps collecting server-side).

### A24 EinMusic module (upload + playback + playlists + Navidrome)

- `einmusic` (BFF) stores MP3s as files under `DATA_DIR/einmusic/<trackId>.mp3` with metadata in `music_tracks` (sub, title, bytes, created_at) — files, not SQLite blobs, keeps the DB small and allows streamed reads. Playlists in `music_playlists` + `music_playlist_tracks` (ordered by `position`), all scoped per `sub`.
- `POST /api/einmusic/tracks?name=<file.mp3>` accepts the raw body as the track (`audio/mpeg`/`application/octet-stream`, ≤ 50 MB), derives the title from the filename; `GET /tracks` lists, `GET /tracks/:id/stream` serves the file with `Range` support (206 + `Content-Range`/`Accept-Ranges`, 416 on bad ranges), `DELETE /tracks/:id` removes file + row + playlist references; foreign ids → 404.
- Playlists: `GET/POST /playlists`, `GET /playlists/:id` (ordered tracks), `PUT /playlists/:id {name?, trackIds?}` (atomic replace), `DELETE /playlists/:id`; trackIds must belong to the caller (400 otherwise).
- Navidrome bridging reuses the sealed navidrome connector credential (D41): `GET /api/einmusic/navidrome/playlists` + `GET /navidrome/playlists/:id` map `getPlaylists`/`getPlaylist` results, `GET /navidrome/stream?songId=` proxies `stream.view` bytes with auth server-side; 424 when no navidrome credential exists.
- The `/einmusic` page: upload button + track list (play / add-to-playlist / delete), playlists section (create, expand, play in order, remove tracks, delete), and a Navidrome section showing its playlists when a credential exists (hint + link to `/navidrome` otherwise — shown only while the navidrome module is enabled). Playback fetches the stream through the BFF and plays it via an object URL — the bearer token can ride the fetch, an `<audio src>` could not (D48). DE + EN + RU + FR.

### A25 PDF module (in-app PDF display)

- `pdf` is a **frontend-only** module (no BFF counterpart): the `/pdf` page accepts a PDF via file picker (`application/pdf`) or via `?src=` carrying an `/api`-relative path fetched through the authenticated API client (D48 pattern).
- The document renders in-app with pdf.js (`pdfjs-dist`) — pages drawn to canvases fit to the container width, sequential render, cancellable on unmount/source change; works in browsers and the Android WebView where native PDF embeds do not exist.
- Filename or `?title=` shows as heading plus the page count; load/parse failures show a translated error; DE + EN + RU + FR.

### A26 Passman module (read-only vault viewer)

- `passman` (BFF, `requires: nextcloud`) proxies `GET /api/passman/vaults` → `/index.php/apps/passman/api/v2/vaults` and `GET /api/passman/vaults/:guid` → the vault with its (still encrypted) credentials; 424 when Nextcloud isn't connected, upstream status preserved through the global `NextcloudError` mapping.
- The `/passman` page lists vaults (name); selecting one prompts for the vault password, which is verified locally by SJCL-decrypting `challenge_password` — wrong password shows a translated error, never leaves the app.
- On unlock the credentials decrypt client-side (SJCL `ccm`/iter 1000/ks 256/ts 64, base64-wrapped): `password`, `url`, `description`, `custom_fields`, `files`, `otp`; label/username/email/tags are plaintext per the Passman API.
- Search filters on label/username/email/description/tags; clicking a tag filters to it; a copy button per password, url and each custom field writes to the clipboard (secret custom fields stay masked); a Lock button drops the key + plaintexts from memory.
- `credential.tags` is normalized defensively — the API returns `{text}[]`, a lone `{text}` object, an assoc-array object, or a JSON string depending on PHP serialization; any shape flattens to a string list, never throws.
- Read-only: no mutation endpoints, no EinChat tool (D50). DE + EN + RU + FR.

### A27 Talk module (basic chat + image send)

- `talk` (BFF, `requires: nextcloud`): `GET /api/talk/rooms` lists conversations (token, displayName, type, unread, lastMessage preview); `GET /api/talk/rooms/:token/messages?lastKnown=&limit=` returns history (`lookIntoFuture=0`, `setReadMarker=0` — never moves the read marker); `POST /rooms/:token/messages {text}` sends with a generated `referenceId`.
- `POST /api/talk/rooms/:token/image?name=<file>` takes raw image bytes (≤ 20 MB): MKCOL `Talk/` (405 ok) → PUT into `Talk/<name>` (sanitized, collision-suffix) → OCS `files_sharing` share `shareType=10` → 201 with the created message; `GET /api/talk/file?path=` proxies file bytes for inline display (path must not escape the files root — `..` rejected 400).
- The `/talk` page: room list (name + unread badge + last-message preview), message pane (bubbles with actor name + time, image attachments rendered via authenticated blob → objectURL, system messages styled), composer (text input + Enter/send + image attach button), polls messages every ~4 s while a room is open and rooms every ~30 s. Read marker untouched. DE + EN + RU + FR.
- EinHub shows Talk rooms with `unreadMessages > 0` as notification items (D42); no EinChat tool (D51).

### A28 Matrix module (basic chat + file upload)

- `matrix` is a `userPass` connector (`MODULE_MATRIX_URL` optional default): `POST /api/matrix/credentials` does `m.login.password` and seals the returned `{accessToken, userId, deviceId}` — the raw password is never persisted; `DELETE` logs out upstream (`/_matrix/client/v3/logout`, best-effort) then drops the row.
- `GET /api/matrix/rooms` → joined rooms with resolved `m.room.name` (id fallback); `GET /api/matrix/rooms/:id/messages?from=&limit=` → `dir=b` event chunk + `end` token; `POST /rooms/:id/messages {text}` → `m.text` with generated txnId; `POST /rooms/:id/file?name=` → `media/v3/upload` then `m.image`/`m.file` message; `GET /api/matrix/media?mxc=` → proxied `download` bytes (mxc:// only, else 400). 424 when not connected.
- The `/matrix` page: `ConnectorPage` until connected; then room list → drill-in chat pane (sender localpart, timestamp, images inline via authenticated blob, other events collapsed to system lines), composer with text + file attach. Polls rooms 30 s / messages 4 s. DE + EN + RU + FR.
- EinHub gets a Matrix unread item from `unread_notifications` (D42); `matrix_rooms` lists room names to EinChat (no message content, D52).

### A29 Module navigation: search + tag filter

- Every `AppModule` with a nav entry declares `nav.group` (a `nav.group.*` i18n key) used as its filter tag: core (einhub, einchat), data (tables, wiki, csv-manager, pdf, passman), media (audiobookshelf, navidrome, einmusic), communication (email, gotify, talk, matrix), integrations (yamtrack, trek, gitlab, github), system (monitor, authentik, nextcloud).
- The nav renders a flat alphabetical list of module links — EinHub always first, the rest ordered by translated name. A search input filters by name (case-insensitive substring); a **Tags** button to its right opens a multi-select dropdown of the group tags and restricts the list to modules carrying any selected tag. Filters combine (search AND tag selection); a "no matches" hint shows when nothing fits.
- The EinHub unread badge keeps rendering on its nav link. All filtering honours the existing visibility rules (MODULES registry, D46 Nextcloud toggles, D47 per-user disablement); labels and hints are translated DE + EN + RU + FR.

### A30 EinDAV (contacts, calendar, files via DAV — Android device sync)

- `eindav` (BFF, `requires: ["nextcloud"]`) speaks CardDAV/CalDAV/WebDAV against `/remote.php/dav/{addressbooks,calendars}/users/<login>/` and the files root with the stored Nextcloud credential: `GET /api/eindav/addressbooks`, `GET /api/eindav/contacts?book=`, `PUT/DELETE /api/eindav/contact`, `GET /api/eindav/calendars`, `GET /api/eindav/events?cal=&from=&to=`, `PUT/DELETE /api/eindav/event`, `GET /api/eindav/files?path=`, `GET /api/eindav/file?path=` (download), `PUT/DELETE /api/eindav/file?path=`, `POST /api/eindav/folder?path=`. 424 unconnected; upstream status mapped; `..` path segments and object hrefs outside `/remote.php/dav/` rejected with 400.
- Contacts are exchanged as vCard 3.0 (the BFF parses FN/EMAIL/TEL/NOTE for display and composes vCards from structured fields for writes); events as iCalendar VEVENT (parses UID/SUMMARY/DTSTART/DTEND/LOCATION/DESCRIPTION, composes from structured fields). Writes use PUT to the object's href (new objects get a `<uid>.vcf|.ics` name); deletes use DELETE on the href.
- `eindav_contacts` is the module's EinChat tool (D41): searches all of the user's CardDAV address books by name/email/phone substring and returns `{book, fn, emails, tels, note}` (max 50) — parsed fields only, never the raw vCard; `{error: "nextcloud is not connected"}` when unlinked.
- The `/eindav` page has three tabs: Contacts (book picker, list, inline edit form, delete, per-contact `.vcf` export, **Sync to device** on Android), Calendar (calendar picker, from/to range, event list, inline edit form, all-day toggle, delete, per-event `.ics` export, **Sync to device** on Android), Files (breadcrumb browser, upload, new folder, download, delete). DE + EN + RU + FR.
- Android device sync (D54): the `EinDav` Capacitor plugin registers the `einring` AccountManager account and real contacts/calendar sync-adapter services; JS passes the already-parsed contacts/events — no HTTP or credentials in native code. Sync is two-way: `pullChanges` surfaces provider `DIRTY` rows which the app writes back through the BFF (`markClean` stamps the new server uid), then server state is pushed down as a full replace. Manifest gains READ/WRITE_CONTACTS + READ/WRITE_CALENDAR + READ/WRITE_SYNC_SETTINGS, requested at runtime via the plugin's permission aliases.

### A31 Recipes module (Nextcloud Cookbook format, read-only display)

- `recipes` (BFF, `requires: ["nextcloud"]`) reads the user's Cookbook folder via WebDAV: `GET /api/recipes` lists recipes under `MODULE_RECIPES_FOLDER` (default `Recipes`) by PROPFINDing the folder and parsing each subfolder's `recipe.json` (schema.org JSON-LD); `GET /api/recipes/:id` returns the parsed recipe; `GET /api/recipes/:id/image` proxies `full.jpg`/`thumb.jpg` bytes so the bearer token stays server-side. 424 unconnected; missing folder → empty list, missing recipe → 404.
- Parsed shape: `{id, name, description, image(bool), keywords[], category, cuisine, servings, prepTime/cookTime/totalTime (ISO-8601 raw), ingredients[], instructions[]}` — instructions flatten HowToStep `text` and HowToSection `itemListElement` entries, tolerating strings; tolerant of Cookbook's varied field shapes (string or array keywords, image as string or `url` object).
- The `/recipes` page lists recipes (name, keyword chips, total time) with a search box; tapping opens a detail pane (image, description, servings/times, ingredient list, numbered instruction steps, back). Read-only per the ask. DE + EN + RU + FR.
- `recipes_search` EinChat tool (D41): name/keyword/ingredient substring search over the parsed list, returning `{id, name, ingredients[]}` — enough for the model to answer "what can I cook with X" without shipping full instructions.
