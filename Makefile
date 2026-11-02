.DEFAULT_GOAL := build

.PHONY: install build run dev deploy test lint typecheck tokens android sync android-open

# Make is a thin, memorable facade; pnpm scripts remain the canonical commands.
install:
	pnpm install

tokens:
	pnpm tokens:build

build:
	pnpm build

run: dev

# Full local test setup: deps + token build, then the dev servers (vite :5173, BFF :3000).
# Opens the app in the browser once vite answers (backgrounded; `start` = Windows).
dev: install tokens
	( for i in $$(seq 1 60); do curl -fsS http://localhost:5173 >/dev/null 2>&1 && break; sleep 1; done; \
	  start "" "http://localhost:5173" ) & \
	pnpm dev

# Production-like test deploy: build the image and restart the local container on :3000.
# AUTHENTIK_* come from .env at runtime — the VITE_* build args stay unset (fallback only).
# Opens the app in the browser once /healthz answers.
deploy:
	docker build -t einring:dev .
	-docker rm -f einring-dev
	docker run -d --name einring-dev -p 3000:3000 --env-file .env \
	  -v einring-data:/data --restart unless-stopped einring:dev
	@for i in $$(seq 1 30); do curl -fsS http://localhost:3000/healthz >/dev/null 2>&1 && break; sleep 1; done; \
	  start "" "http://localhost:3000"

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

android:
	pnpm --filter @einring/app android:run

sync:
	pnpm --filter @einring/app android:sync

android-open:
	pnpm --filter @einring/app android:open
