/**
 * Where Pyodide is downloaded from, and where the worker scripts live.
 *
 * The index URL comes from `publicEnv`, which is deliberately the one config
 * module free of `server-only` — a Client Component and a plain Node test run
 * can both import it, which the server-side env module would make impossible.
 */
import { publicEnv } from '@/lib/env';

export const DEFAULT_PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/';

/**
 * A missing trailing slash turns `indexUrl + 'pyodide.js'` into a 404 several
 * seconds into a timed interview, reported as "the Python runtime could not be
 * loaded". Normalise once, here, rather than in each of the two callers.
 */
export function pyodideIndexUrl(): string {
  const configured = publicEnv.pyodideIndexUrl.trim();
  const value = configured.length > 0 ? configured : DEFAULT_PYODIDE_INDEX_URL;
  return value.endsWith('/') ? value : `${value}/`;
}

/** Served from `public/workers/`; classic workers, see `worker-bridge.ts`. */
export const JS_WORKER_URL = '/workers/js-runner.js';
export const PY_WORKER_URL = '/workers/py-runner.js';
