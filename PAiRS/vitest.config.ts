import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'vendor'],
    // Index/SQLite tests are I/O heavy; CI runners (esp. Windows, with
    // antivirus scanning temp files) blow through vitest's 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
