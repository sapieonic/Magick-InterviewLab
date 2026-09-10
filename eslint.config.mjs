import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * Flat config. eslint-config-next 16 ships flat presets directly, so the
 * FlatCompat shim that older Next projects use is not only unnecessary here,
 * it crashes on the nested plugin objects.
 */
export default [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'src/generated/**',
      'public/workers/**',
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
