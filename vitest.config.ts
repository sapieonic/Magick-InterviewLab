import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/unit/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    // Process isolation: several suites poke at module-level singletons.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/features/**', 'src/lib/**'],
      exclude: ['src/generated/**', '**/*.d.ts'],
    },
  },
});
