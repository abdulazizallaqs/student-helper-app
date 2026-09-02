import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup/env.setup.js'],
    globalSetup: ['./tests/setup/globalSetup.js'],
    testTimeout: 15000,
    hookTimeout: 20000,
    // Integration tests share one MySQL test database (truncated between
    // tests) - running test files in parallel workers would race on it.
    fileParallelism: false,
  },
});
