import { defineConfig } from 'drizzle-kit';

/**
 * `pnpm db:generate` diffs the Drizzle schema and emits SQL.
 *
 * The emitted files are a starting point, not the source of truth: the
 * migrations in `infra/migrations` are hand-finished, because privilege grants,
 * row-level security policies and the audit guard trigger are the parts that
 * matter most here and a schema differ does not know about any of them.
 * `scripts/migrate.ts` is what applies them, and it refuses to run if an
 * already-applied migration has been edited.
 */
export default defineConfig({
  schema: './packages/shared/src/db/schema.ts',
  out: './infra/migrations/generated',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://mcpgw:mcpgw@localhost:5432/mcpgateway',
  },
  verbose: true,
  strict: true,
});
