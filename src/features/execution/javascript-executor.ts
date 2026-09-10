/**
 * JavaScript execution: one Web Worker, reused across the test cases of a
 * single run.
 *
 * ## Reuse, and the one case where we cannot
 *
 * Spawning a JS worker is cheap (no runtime to download), but it is not free —
 * at twenty test cases the spawn cost is visible in the "Running…" spinner. So
 * we keep one worker for the whole `execute()`. The exception is a timeout:
 * stopping an infinite loop means `terminate()`, which destroys the worker, so
 * the next test transparently gets a fresh one. `WorkerBridge` respawns lazily
 * on the next `request()`, which is why `recover()` here has nothing to do.
 *
 * The worker is *not* disposed between `execute()` calls either. A candidate
 * hitting Run repeatedly while iterating is the normal case, and the executor
 * registry in `index.ts` is memoised precisely so that keystroke-driven runs
 * do not each pay for a spawn.
 *
 * ## Isolation between tests
 *
 * Each test recompiles the source into a fresh function with fresh globals, so
 * module-level state does not leak from test 1 into test 2 — the failure that
 * makes a memoising solution mysteriously pass tests it should fail. What is
 * *not* reset is the worker realm itself (a candidate who assigns to
 * `globalThis.cache` keeps it). Full isolation would mean a worker per test;
 * that trade was made deliberately and is the first thing to revisit if a
 * cross-test-contamination bug is ever reported.
 */

import { assertRuntimeSupport } from './capabilities';
import { JS_WORKER_URL } from './runtime-config';
import { nextRequestId, runTestLoop } from './test-runner';
import type {
  CodeExecutor,
  ExecutionRequest,
  ExecutionResult,
  Language,
  WorkerResultMessage,
} from './types';
import { parseWorkerResult } from './types';
import type { WorkerFactory } from './worker-bridge';
import { defaultWorkerFactory, WorkerBridge } from './worker-bridge';

export interface JavaScriptExecutorOptions {
  /** Injected by the unit tests; production uses the real `/workers/js-runner.js`. */
  workerFactory?: WorkerFactory;
}

export class JavaScriptExecutor implements CodeExecutor {
  readonly language: Language = 'javascript';

  readonly #bridge: WorkerBridge;
  /**
   * Capability checks are skipped when a factory is injected: the tests run in
   * Node, where `Worker` does not exist, and refusing to run there would make
   * the fake worker pointless.
   */
  readonly #checkCapabilities: boolean;

  constructor(options: JavaScriptExecutorOptions = {}) {
    this.#checkCapabilities = options.workerFactory === undefined;
    this.#bridge = new WorkerBridge(
      options.workerFactory ?? defaultWorkerFactory(JS_WORKER_URL, 'interviewlab-js-runner'),
    );
  }

  /**
   * Nothing to download, but spawning early moves the worker startup off the
   * critical path of the first Run. Safe to call repeatedly.
   */
  async warmUp(): Promise<void> {
    if (this.#checkCapabilities) assertRuntimeSupport('javascript');
    this.#bridge.ensureWorker();
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Rejects rather than returning a result: an unsupported browser is an
    // environment fault, and rendering it as "your code errored" on every test
    // row would be actively misleading.
    if (this.#checkCapabilities) assertRuntimeSupport('javascript');

    const sourceCode = request.sourceCode;

    return runTestLoop(request, {
      runTest: (test, timeoutMs, signal) => {
        const id = nextRequestId('js');
        return this.#bridge.request<WorkerResultMessage>(
          { type: 'run', id, sourceCode, input: test.input },
          {
            timeoutMs,
            signal,
            match: (data) => parseWorkerResult(data, id),
          },
        );
      },
      // The bridge already terminated the dead worker and will spawn a
      // replacement on the next request; there is no cached runtime state.
      recover: () => {},
    });
  }

  dispose(): void {
    this.#bridge.dispose();
  }
}
