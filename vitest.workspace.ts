import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
      environment: 'node',
      globals: false,
      env: { LOG_LEVEL: 'silent', OTEL_SDK_DISABLED: 'true' },
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
