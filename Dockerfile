# einring - single image: Fastify BFF serving the API under /api and the web build as static files.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/tokens/package.json packages/tokens/
COPY apps/bff/package.json apps/bff/
COPY apps/app/package.json apps/app/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/tokens packages/tokens
COPY apps/bff apps/bff
COPY apps/app apps/app

# Public OIDC settings are baked into the web bundle at build time (no secrets).
ARG VITE_AUTHENTIK_ISSUER
ARG VITE_AUTHENTIK_CLIENT_ID
ENV VITE_AUTHENTIK_ISSUER=$VITE_AUTHENTIK_ISSUER VITE_AUTHENTIK_CLIENT_ID=$VITE_AUTHENTIK_CLIENT_ID

RUN pnpm --filter @einring/tokens build \
 && pnpm --filter @einring/app build \
 && pnpm --filter @einring/bff build \
 && pnpm --filter @einring/bff deploy --prod --legacy /out/bff

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data STATIC_DIR=/srv/web
WORKDIR /srv/bff
COPY --from=build /out/bff ./
COPY --from=build /repo/apps/app/dist /srv/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
