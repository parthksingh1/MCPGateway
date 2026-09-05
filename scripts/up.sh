#!/usr/bin/env bash
#
# Brings the whole stack up, applies migrations, loads data and prints the URLs.
# This is what `make demo` runs.
#
# Everything here is idempotent: run it again and it converges rather than
# duplicating. Port conflicts are the one thing it cannot solve for you, so it
# checks for them up front and tells you exactly what to set.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/infra/docker-compose.yml")
[ -f "$ROOT/.env" ] && COMPOSE+=(--env-file "$ROOT/.env")

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '%sMissing %s.%s %s\n' "$RED" "$1" "$RESET" "$2"
    exit 1
  }
}

step "Checking prerequisites"
require docker "Install Docker Desktop and start it."
require node   "Install Node.js 20 or newer."
docker info >/dev/null 2>&1 || { printf '%sDocker is installed but not running.%s\n' "$RED" "$RESET"; exit 1; }
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo running)"
ok "node $(node -v)"

if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found — enabling it through corepack"
  corepack enable >/dev/null 2>&1 || npm install -g pnpm@9.15.4 >/dev/null 2>&1
fi
ok "pnpm $(pnpm -v)"

step "Checking published ports"
# A port already in use is by far the most common reason a first run fails, and
# the resulting error (an auth failure against somebody else's database) is
# confusing enough to be worth pre-empting.
conflict=0
check_port() {
  local port="$1" name="$2" var="$3"
  if node -e "
    const net = require('node:net');
    const s = net.createServer();
    s.once('error', () => process.exit(1));
    s.once('listening', () => s.close(() => process.exit(0)));
    s.listen(${port}, '0.0.0.0');
  " 2>/dev/null; then
    return 0
  fi
  warn "port ${port} (${name}) is already in use — set ${var} in .env to a free port"
  conflict=1
}

check_port "${POSTGRES_PORT:-5432}" postgres POSTGRES_PORT
check_port "${REDIS_PORT:-6379}"    redis    REDIS_PORT
check_port "${GATEWAY_PORT:-8080}"  gateway  GATEWAY_PORT
check_port "${CONSOLE_PORT:-3000}"  console  CONSOLE_PORT

if [ "$conflict" -eq 1 ]; then
  say ""
  say "  ${DIM}Create a .env at the repository root, for example:${RESET}"
  say "  ${DIM}    POSTGRES_PORT=5433${RESET}"
  say "  ${DIM}    REDIS_PORT=6380${RESET}"
  say "  ${DIM}Only the published host ports change; nothing inside the stack does.${RESET}"
  exit 1
fi
ok "all published ports are free"

step "Installing workspace dependencies"
(cd "$ROOT" && pnpm install --prefer-offline >/dev/null)
ok "dependencies installed"

step "Building images and starting services"
say "    ${DIM}First run pulls images and compiles the workspace; expect a few minutes.${RESET}"
"${COMPOSE[@]}" up -d --build

step "Waiting for datastores"
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" ps --format json postgres 2>/dev/null | grep -q '"Health":"healthy"'; then break; fi
  sleep 2
done
ok "postgres and redis are accepting connections"

step "Applying migrations"
(cd "$ROOT" && pnpm db:migrate)

step "Loading data"
say "    ${DIM}Tenants, users, a 50k-row warehouse and a week of audit history.${RESET}"
(cd "$ROOT" && pnpm seed)

step "Verifying the audit chain"
(cd "$ROOT" && pnpm verify:audit) || warn "chain verification reported a problem"

step "Waiting for the gateway"
for _ in $(seq 1 60); do
  if curl -sf "http://localhost:${GATEWAY_PORT:-8080}/healthz" >/dev/null 2>&1; then break; fi
  sleep 2
done

cat <<BANNER

${BOLD}The stack is up.${RESET}

  ${BOLD}Console${RESET}      http://localhost:${CONSOLE_PORT:-3000}
  Gateway API  http://localhost:${GATEWAY_PORT:-8080}
  Identity     http://localhost:${IDP_PORT:-9000}
  Traces       http://localhost:${JAEGER_PORT:-16686}
  Dashboards   http://localhost:${GRAFANA_PORT:-3001}    ${DIM}(admin / admin)${RESET}
  Metrics      http://localhost:${PROMETHEUS_PORT:-9090}

${BOLD}Sign in${RESET} with any of these. The password is ${BOLD}Passw0rd!${RESET} for all of them.

  alice.chen@acme-corp.com     ${DIM}analyst, West   — sees the records she owns${RESET}
  bob.martinez@acme-corp.com   ${DIM}manager, West   — sees the whole West territory${RESET}
  dana.olsen@acme-corp.com     ${DIM}admin           — sees the whole tenant${RESET}
  liam.novak@initech.dev       ${DIM}analyst         — restricted plan, hits policy denials${RESET}

${BOLD}Worth running${RESET}

  pnpm oauth:walkthrough                 ${DIM}the token exchange, step by step${RESET}
  pnpm verify:audit --corrupt-row 42     ${DIM}tamper with a row and watch it get caught${RESET}
  pnpm bench                             ${DIM}measure this machine, then fill in docs/BENCHMARKS.md${RESET}

  ${DIM}docs/DEMO.md is a ten-minute walkthrough of all of it.${RESET}

BANNER
