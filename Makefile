SHELL := /bin/bash
COMPOSE := docker compose -f infra/docker-compose.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: demo
demo: ## Bring up the entire stack, migrate, seed, and print the URLs
	@bash scripts/up.sh

.PHONY: up
up: ## Start the stack in the background
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop the stack and delete all volumes
	$(COMPOSE) down -v --remove-orphans

.PHONY: logs
logs: ## Tail logs for every service
	$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

.PHONY: install
install: ## Install workspace dependencies
	pnpm install --frozen-lockfile=false

.PHONY: migrate
migrate: ## Apply database migrations
	pnpm db:migrate

.PHONY: seed
seed: ## Load tenants, users, warehouse rows and audit history
	pnpm seed

.PHONY: reset
reset: ## Wipe and reload all data
	pnpm reset

.PHONY: verify-audit
verify-audit: ## Walk the audit hash chain and report the first break
	pnpm verify:audit

.PHONY: bench
bench: ## Run the load test against the local stack
	pnpm bench

.PHONY: check
check: ## typecheck + lint + unit tests
	pnpm typecheck && pnpm lint && pnpm test:unit

.PHONY: test
test: ## Run unit tests
	pnpm test:unit

.PHONY: test-integration
test-integration: ## Run Testcontainers integration suite
	pnpm test:integration

.PHONY: dev
dev: ## Run every app in watch mode against dockerised datastores
	$(COMPOSE) up -d postgres redis otel-collector jaeger prometheus loki grafana
	pnpm dev
