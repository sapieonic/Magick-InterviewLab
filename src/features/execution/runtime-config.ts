/**
 * Where Pyodide is downloaded from.
 *
 * ## Why this is not `import { publicEnv } from '@/lib/env'`
 *
 * `src/lib/env.ts` begins with `import 'server-only'`, whose entire
 * implementation is a top-level `throw`. It is a no-op *only* under React's
 * `react-server` export condition. Pull it into a Client Component, a Web
 * Worker host module, or a plain Node vitest run and the module body throws
 * before `publicEnv` is ever read — so the "public" half of that file is not
 * actually reachable from the browser today.
 *
 * Rather than reach across an ownership boundary to split that file, this
 * module reads the same variable with the same default. `NEXT_PUBLIC_*` reads
 * are string-substituted by Next at build time, so the literal member
 * expression below is what makes it work in a client bundle — do not refactor
 * it into `process.env[name]`, which the compiler cannot see through.
 *
 * When `@/lib/env` grows a genuinely browser-safe entry point, this should
 * become a one-line re-export of it.
 */

/** Keep in sync with `publicEnv.pyodideIndexUrl` in `src/lib/env.ts`. */
export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/';

/**
 * A missing trailing slash turns `indexUrl + 'pyodide.js'` into a 404 several
 * seconds into a timed interview, reported as "the Python runtime could not be
 * loaded". Normalise once, here, rather than in each of the two callers.
 */
export function pyodideIndexUrl(): string {
  const configured =
    typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_PYODIDE_INDEX_URL : undefined;
  const value =
    typeof configured === 'string' && configured.trim().length > 0
      ? configured.trim()
      : DEFAULT_PYODIDE_INDEX_URL;
  return value.endsWith('/') ? value : `${value}/`;
}

/** Served from `public/workers/`; classic workers, see `worker-bridge.ts`. */
export const JS_WORKER_URL = '/workers/js-runner.js';
export const PY_WORKER_URL = '/workers/py-runner.js';
