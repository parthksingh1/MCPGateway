import { defineConfig } from 'vitest/config';

/**
 * Root configuration. Projects (unit / integration) are declared in
 * `vitest.workspace.ts`; coverage is configured once here because thresholds
 * apply across the whole run rather than per project.
 */
export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts', '**/__fixtures__/**'],
      thresholds: {
        // The three pillars carry an explicit floor. Everything else is
        // measured but not gated, so coverage pressure does not push tests
        // towards trivial assertions.
        //
        // The audit floor names hash.ts specifically. The writer, reader and
        // verifier are SQL-bound — their behaviour is the transaction and the
        // grants, which a mocked database would not exercise — so they are
        // covered by tests/integration/audit.test.ts against real Postgres
        // instead. Gating them here would only reward a fake.
        'packages/auth/src/**': { lines: 80, functions: 80, statements: 80, branches: 65 },
        'packages/audit/src/hash.ts': { lines: 80, functions: 80, statements: 80, branches: 65 },
        'packages/rate-limit/src/**': { lines: 80, functions: 80, statements: 80, branches: 65 },
      },
    },
  },
});
