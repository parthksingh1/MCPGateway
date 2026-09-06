# Build context is the repository root so workspace links resolve.
#
# No `# syntax=` directive: pinning an external frontend means every build first
# pulls an image from Docker Hub, which turns a network blip into a build
# failure. Modern BuildKit supports RUN --mount natively.

FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true HUSKY=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @mcpgateway/console build

# Static assets only. The console has no server of its own: everything it needs
# comes from the gateway, which is also where the session cookie lives.
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
COPY infra/docker/dashboard.nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
