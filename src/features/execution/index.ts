/**
 * Public entry point for code execution, and the seam that makes browser
 * execution a *choice* rather than an assumption.
 *
 * ## The registry is the swap point
 *
 * Every caller asks for `getExecutor(language)` or `runTests(request)`; nobody
 * outside this folder constructs a `JavaScriptExecutor` or reaches for a
 * worker. When the server-side sandbox lands, adding it is a change to the
 * `create()` switch below — `new RemoteSandboxExecutor(language)` behind a
 * feature flag — and nothing in the editor, the results table or the
 * submission flow has to know. That is the entire reason `CodeExecutor` is an
 * interface and `ExecutionRequest`/`ExecutionResult` are plain serialisable
 * data: they are already the shape of an HTTP request and response.
 *
 * ## Why the registry is memoised
 *
 * Pyodide is a ~10MB WebAssembly download. Constructing a `PythonExecutor` per
 * render — and this code is reached from a Monaco editor that re-renders on
 * every keystroke — would either re-download it or, worse, leak a worker per
 * keystroke until the tab dies. One instance per language per tab, disposed
 * explicitly.
 *
 * Constructing an executor is side-effect free (no worker is spawned until the
 * first `warmUp()`/`execute()`), so this module is safe to import during SSR.
 */

import { JavaScriptExecutor } from './javascript-executor';
import { PythonExecutor } from './python-executor';
import type { CodeExecutor, ExecutionRequest, ExecutionResult, Language } from './types';

const registry = new Map<Language, CodeExecutor>();

function create(language: Language): CodeExecutor {
  switch (language) {
    case 'javascript':
      return new JavaScriptExecutor();
    case 'python':
      return new PythonExecutor();
    default: {
      const exhaustive: never = language;
      throw new Error(`No executor registered for language: ${String(exhaustive)}`);
    }
  }
}

/** Memoised per language, per tab. See the file header for why. */
export function getExecutor(language: Language): CodeExecutor {
  const existing = registry.get(language);
  if (existing) return existing;
  const created = create(language);
  registry.set(language, created);
  return created;
}

/**
 * Tears down every live runtime. Call on unmount of the interview workspace —
 * a leaked Pyodide worker holds tens of megabytes and keeps running whatever
 * the candidate last started.
 */
export function disposeExecutors(): void {
  for (const executor of registry.values()) {
    try {
      executor.dispose();
    } catch {
      // Disposal must not be able to prevent disposal of the others.
    }
  }
  registry.clear();
}

/** Convenience wrapper: pick the executor for `request.language` and run. */
export async function runTests(request: ExecutionRequest): Promise<ExecutionResult> {
  return getExecutor(request.language).execute(request);
}

export * from './types';
export { detectRuntimeCapabilities, assertRuntimeSupport, requirementsFor } from './capabilities';
export { normalizeOutput, outputMatches, asSingleNumber } from './normalize';
export { defaultGrader, normalizeWeight, overallStatus, scoreResults } from './scoring';
export type { Grader, ScoreSummary } from './scoring';
export { defaultStarterCode } from './starter-code';
export { JavaScriptExecutor } from './javascript-executor';
export type { JavaScriptExecutorOptions } from './javascript-executor';
export { PythonExecutor } from './python-executor';
export type { PythonExecutorOptions } from './python-executor';
export { WorkerBridge, defaultWorkerFactory } from './worker-bridge';
export type { BridgeOutcome, WorkerFactory, WorkerLike } from './worker-bridge';
export {
  DEFAULT_PYODIDE_INDEX_URL,
  JS_WORKER_URL,
  PY_WORKER_URL,
  pyodideIndexUrl,
} from './runtime-config';
