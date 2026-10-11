import { defineConfig } from 'vitest/config';

// Unit tests live next to the code; tests/ holds the Playwright smoke test.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
