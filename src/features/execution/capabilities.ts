/**
 * Feature detection, run before we promise a candidate that their code will
 * execute.
 *
 * This exists because of the failure mode it prevents: a candidate on a locked
 * down corporate browser, or an old WebView, clicks Run and gets a spinner that
 * never resolves — during a timed interview. Detecting the missing primitive
 * lets us say *which* one is missing, which is the difference between a
 * support ticket that can be answered and one that cannot.
 *
 * Everything is `typeof`-guarded rather than referenced directly: this module
 * is imported by the executor registry, which is itself imported during SSR
 * where `Worker` genuinely does not exist.
 */

import type { Language, RuntimeCapabilities } from './types';
import { ExecutorEnvironmentError } from './types';

export function detectRuntimeCapabilities(): RuntimeCapabilities {
  const webWorker = typeof Worker === 'function';
  const webAssembly =
    typeof WebAssembly === 'object' &&
    WebAssembly !== null &&
    typeof WebAssembly.instantiate === 'function';

  const missing: string[] = [];
  if (!webWorker) missing.push('Web Workers');
  if (!webAssembly) missing.push('WebAssembly');

  const ok = webWorker && webAssembly;
  return {
    webAssembly,
    webWorker,
    ok,
    reason: ok
      ? undefined
      : `This browser does not support ${missing.join(' or ')}. ` +
        'Use a current version of Chrome, Edge, Firefox or Safari.',
  };
}

/**
 * Per-language requirements. JavaScript only needs a Worker; Python also needs
 * WebAssembly for Pyodide. Reporting "WebAssembly is missing" to someone
 * writing JavaScript would send them chasing the wrong problem.
 */
export function requirementsFor(language: Language): { webWorker: true; webAssembly: boolean } {
  return { webWorker: true, webAssembly: language === 'python' };
}

/** Throws `ExecutorEnvironmentError` if this browser cannot host `language`. */
export function assertRuntimeSupport(language: Language): void {
  const caps = detectRuntimeCapabilities();
  const needs = requirementsFor(language);

  const missing: string[] = [];
  if (needs.webWorker && !caps.webWorker) missing.push('Web Workers');
  if (needs.webAssembly && !caps.webAssembly) missing.push('WebAssembly');
  if (missing.length === 0) return;

  throw new ExecutorEnvironmentError(
    `Cannot run ${language} in this browser: ${missing.join(' and ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} unavailable. ` +
      'Use a current version of Chrome, Edge, Firefox or Safari.',
    { language },
  );
}
