import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
  },
});
