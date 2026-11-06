import { defineConfig } from 'vitest/config';

// Integration tests need a disposable PostgreSQL superuser connection supplied by the
// environment (TEST_DATABASE_ADMIN_URL). The global setup creates a uniquely named database,
// bootstraps least-privilege roles with random per-run passwords, applies migrations, and
// drops the database afterwards. No credentials are stored in the repository.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
    globalSetup: ['packages/db/src/testing/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
