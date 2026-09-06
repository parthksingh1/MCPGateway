# Build context is the repository root so workspace links resolve.
#
# No `# syntax=` directive: pinning an external frontend means every build first
# pulls an image from Docker Hub, which turns a network blip into a build
# failure. Modern BuildKit supports RUN --mount natively.

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
RUN pnpm --filter @mcpgateway/mcp-policy-engine... build

FROM base AS runtime
ENV NODE_ENV=production
# The built workspace is copied wholesale rather than reinstalled. A second
# `pnpm install --prod` in this stage would reach the registry at image-build
# time — slower, and a network blip fails the build for no correctness benefit.
# Trimming dev dependencies here is a size optimisation and would be done with
# `pnpm deploy`, not another install.
COPY --from=build /app /app

WORKDIR /app/apps/mcp-servers/policy-engine
USER node
EXPOSE 7003
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
