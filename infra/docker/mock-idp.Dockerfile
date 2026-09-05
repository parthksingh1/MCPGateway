# syntax=docker/dockerfile:1.7
# Build context is the repository root so workspace links resolve.

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
# The pnpm store is cached across builds, so a dependency change costs a
# resolve rather than a full download.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json turbo.json ./
RUN pnpm --filter @mcpgateway/identity... build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# Prune dev dependencies after building rather than installing twice.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod   && pnpm store prune

WORKDIR /app/apps/mock-idp
USER node
EXPOSE 9000
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
