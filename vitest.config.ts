import { defineConfig } from 'vitest/config';

// Root config exists so `vitest` resolves aliases identically in every project.
export default defineConfig({
  test: { passWithNoTests: true },
});
