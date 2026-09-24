.DEFAULT_GOAL := build

.PHONY: install build run dev test lint typecheck tokens android sync android-open

# Make is a thin, memorable facade; pnpm scripts remain the canonical commands.
install:
	pnpm install

tokens:
	pnpm tokens:build

build:
	pnpm build

run: dev

dev:
	pnpm dev

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
