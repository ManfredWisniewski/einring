# Handoff: OpenRouter usage data as an einring module

Date: 2026-11-02 · Status: plan agreed, not yet decided (D-number pending owner entry)

## Context

Goal: show OpenRouter account data inside einring without standing up an
observability stack. Evaluated Langfuse (OpenRouter native forwarding, 6-service
self-host) and Phoenix (OTEL-first, 1 container, no OpenRouter forwarding) —
both deferred. Chosen approach is "observability lite": the BFF already holds
`LLM_URL` + `LLM_API_KEY`, so a read-only module can query OpenRouter's
management API directly. Pattern: the `stalwart` module (D62) — read-only
connector, verify → status/info endpoints → a page.

## Scope

### Level 1 — account snapshot (this handoff's deliverable)

BFF module `openrouter`:

- `GET /api/openrouter/status` → `{configured: boolean}` — true when
  `ctx.llm`/`LLM_API_KEY` are set (module is inactive/unconfigured otherwise, 424).
- `GET /api/openrouter/info` → account data via `ctx.fetchImpl`:
  - `GET {LLM_URL}/auth/key` → key usage, limit, `is_free_tier`, rate limit
  - `GET {LLM_URL}/credits` → `total_credits`, `total_usage`
  - optional `GET {LLM_URL}/models` → model list
- Auth: `Authorization: Bearer <LLM_API_KEY>` — the key never leaves the BFF
  and never appears in responses.
- Upstream base: `LLM_URL` (strip trailing `/api/v1` suffix is *not* needed —
  OpenRouter's `/api/v1` prefix already matches; document the assumption and
  guard non-OpenRouter `LLM_URL` values, where these endpoints will 404 →
  surface as 502, same convention as other connectors).
- Timeouts: use `ctx.fetchImpl` with the connector-standard timeout; errors
  map like other connectors (401 auth failure, 502 unreachable).

Frontend:

- `openrouter` module page `/openrouter`: cards for credits/usage/key limits/
  rate limit (de/en/ru/fr keys under `modules.openrouter.*`).
- Nav entry + optional settings view per D53/D59 conventions; `hasBackend: true`.
- EinChat tool optional (`openrouter_info`, same shape as `stalwart_info`).

### Level 2 — per-call stats (backlog, not in this deliverable)

OpenRouter returns a `generation` id in each completion response;
`GET /api/v1/generation?id=<id>` yields per-call cost/tokens/latency.
Capture the id in `LlmClient` responses, store per-request stats, expose a
history view. Defer until Level 1 proves the account data is worth watching.

## Explicitly out of scope

- Phoenix/Langfuse/OTEL instrumentation of `LlmClient` — separate phase-2
  decision; keep `LLM_URL` indirection intact so either path stays possible.
- Any write call — read-only by construction (mirrors D62).

## Acceptance criteria (draft for +intent/tests.md)

- `/api/openrouter/status` reports `configured: false` when `LLM_*` is unset;
  info endpoints answer 424 then.
- With `LLM_API_KEY` set, `/api/openrouter/info` returns credits/usage/key
  limits from the real account; the key never appears in any response.
- Upstream failure maps to 502; wrong key to 401.
- Page renders the snapshot in all four locales.
