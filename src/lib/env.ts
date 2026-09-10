/**
 * Client-safe configuration.
 *
 * This module must stay free of `server-only` and of any secret: it is
 * imported by Client Components (branding, the Pyodide loader). Anything
 * secret lives in `env.server.ts`, which the bundler refuses to ship to the
 * browser.
 */
export const publicEnv = {
  appName: process.env.NEXT_PUBLIC_APP_NAME || 'MagicVoice',
  appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
  pyodideIndexUrl:
    process.env.NEXT_PUBLIC_PYODIDE_INDEX_URL || 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/',
} as const;
