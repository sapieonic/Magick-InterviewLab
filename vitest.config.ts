import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node',
    globals: false,
    // .tsx too: component tests (the Markdown renderer's XSS suite) are
    // easier to read as JSX than as createElement chains.
    include: ['test/unit/**/*.test.{ts,tsx}'],
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
