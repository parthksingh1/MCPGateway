import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
      environment: 'node',
      globals: false,
      env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary', 'html'],
        include: ['packages/*/src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts'],
        thresholds: {
          'packages/auth/src/**': { lines: 80, functions: 80, statements: 80, branches: 65 },
          'packages/audit/src/**': { lines: 80, functions: 80, statements: 80, branches: 65 },
          'packages/rate-limit/src/**': { lines: 80, functions: 80, statements: 80, branches: 65 },
        },
      },
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
      environment: 'node',
      globals: false,
      env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
      testTimeout: 180_000,
      hookTimeout: 180_000,
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
    },
  },
]);
