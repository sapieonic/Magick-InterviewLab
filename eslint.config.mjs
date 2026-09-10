import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * Flat config. eslint-config-next 16 ships flat presets directly, so the
 * FlatCompat shim that older Next projects use is not only unnecessary here,
 * it crashes on the nested plugin objects.
 */
const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/generated/**',
      'public/workers/**',
      // Vendored runtimes, staged by scripts/copy-monaco.mjs and
      // scripts/fetch-pyodide.mjs. Not our source; not ours to lint.
      'public/monaco/**',
      'public/pyodide/**',
      'test-results/**',
      'playwright-report/**',
      'next-env.d.ts',
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];

export default config;
