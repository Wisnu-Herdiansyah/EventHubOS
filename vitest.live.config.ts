import { defineConfig } from 'vitest/config';

// Live provider contract tests. They make real network calls and may send real email, so they
// never run in the default unit/integration suites. Each suite skips unless its credentials are
// present in the environment (supplied from the secret store, never committed).
export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.live.test.ts'],
    testTimeout: 30_000,
  },
});
