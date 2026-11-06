# Modules

All modules registered in the app (`apps/app/src/modules/index.ts`) with their
BFF counterpart (`apps/bff/src/modules/registry.ts`).

| Module | What it does | State | Accounts | URL (main software) |
|---|---|---|---|---|
| einhub | Notification hub — aggregates feed items from all modules | released | — (internal) | — |
| tables | Nextcloud Tables: views/rows of a Tables application | released | via Nextcloud | nextcloud.com (Tables app) |
| monitor | Server health: Nextcloud serverinfo, Talk, Authentik stats | released | via Nextcloud + Authentik | nextcloud.com / goauthentik.io |
| wiki | Nextcloud Collectives mirror + RAG Q&A | released | via Nextcloud | nextcloud.com (Collectives) |
| csv-manager | CSV files → import into Nextcloud Tables | released | via Nextcloud | nextcloud.com (Tables) |
| einchat | Chat with LLM + per-module tools | released | env (`LLM_URL`, shared) | openrouter.ai (any OpenAI-compatible endpoint) |
| yamtrack | Watched-media tracker (movies/shows/books/games) | released | one | self-hosted Yamtrack instance |
| audiobookshelf | Audiobook/podcast library + progress | released | one | audiobookshelf.org |
| navidrome | Music streaming library | released | one | navidrome.org |
| trek | Trips & itineraries | released | one | self-hosted Trek instance |
| email | Mail inbox (IMAP + JMAP) | released | multiple (D60) | any IMAP/JMAP server (e.g. Stalwart) |
| gotify | Push-notification stream | released | one | gotify.net |
| gitlab | GitLab todos → notifications | released | one | gitlab.com / self-hosted |
| github | GitHub notifications | released | one | github.com / GHES |
| authentik | IdP admin stats for Monitor | released | one | goauthentik.io |
| nextcloud | Base connection + per-user feature toggles | released | one | nextcloud.com |
| einmusic | MP3 upload/playback + playlists (Navidrome push) | released | via Navidrome | navidrome.org |
| pdf | In-app PDF display from Nextcloud files | released | via Nextcloud | — |
| passman | Nextcloud Passwords vaults (read-only) | testing | via Nextcloud | nextcloud.com (Passwords/Passman) |
| talk | Nextcloud Talk chat + image send | testing | via Nextcloud | nextcloud.com (Talk) |
| matrix | Matrix chat + file upload | testing | one | matrix.org |
| eindav | Contacts/calendar/files via DAV (Android sync) | testing | via Nextcloud | nextcloud.com (CardDAV/CalDAV/WebDAV) |
| recipes | Nextcloud Cookbook recipes (read-only) | testing | via Nextcloud | nextcloud.com (Cookbook) |
| stalwart | Stalwart mail server: principals, mail domains, JMAP capabilities (read-only) | testing | one | stalw.art |
| school | Music-school management (people, lessons, invoicing, messaging) | dev | — (Authentik groups) | — (internal) |
| postges | PostgreSQL table browser — per-user connections, read-only by default | dev | one per user | any PostgreSQL server |

**State** reflects implementation maturity (acceptance criteria + test coverage), not a
formal release process — `dev` = under active construction, `testing` = implemented with
criteria, verify before production use, `released` = in regular use.

**Accounts** — per-user credential model (D41): `one` = single connector credential,
`multiple` = many accounts per user (email only, D60), `via Nextcloud` = uses the shared
Nextcloud app-password connection, `env` = deployment-level config, `—` = no upstream account.
