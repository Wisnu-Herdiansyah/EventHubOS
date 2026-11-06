import { defineConfig } from 'vitest/config';

// Unit tests only; e2e/*.spec.ts run under Playwright (pnpm e2e).
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
