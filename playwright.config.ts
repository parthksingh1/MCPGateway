import { defineConfig, devices } from '@playwright/test';

/**
 * One smoke test against the running stack.
 *
 * It does not start anything: `make demo` is the prerequisite. A Playwright
 * config that boots a nine-container stack on demand would be slower and more
 * fragile than telling the operator to bring it up first.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.CONSOLE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'dark',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
