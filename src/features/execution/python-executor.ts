/**
 * Python execution via Pyodide (CPython compiled to WebAssembly) in a Web
 * Worker.
 *
 * ## Everything here is shaped by one fact: Pyodide costs ~10MB and seconds
 *
 * So it is loaded lazily (never on a page that might not run Python), exactly
 * once, memoised behind a promise, and reused for every test case and every
 * subsequent Run. `warmUp()` exists so the UI can start that download the
 * moment a candidate picks Python from the language dropdown, instead of at
 * the moment they click Run.
 *
 * ## Timeouts are expensive here, unlike JavaScript
 *
 * There is no way to interrupt Python inside Pyodide without a
 * `SharedArrayBuffer` interrupt buffer, and that requires COOP/COEP
 * cross-origin isolation across the entire app. Until we take that on, the
 * only way to stop `while True: pass` is `Worker.terminate()` — which throws
 * away the interpreter. So a timeout costs a full re-download on the next
 * test. That is unpleasant and it is also correct: the alternative is a tab
 * pinned at 100% CPU for the rest of the interview.
 *
 * ## Init failure is not a candidate failure
 *
 * Offline, a blocked CDN, a corporate proxy MITMing jsDelivr: all produce
 * `ExecutorEnvironmentError`, which the UI must render as "the Python runtime
 * is unavailable", never as twenty failed test cases. That is why this method
 * rejects instead of returning an `ExecutionResult` full of errors.
 */

import { assertRuntimeSupport } from './capabilities';
import { PY_WORKER_URL, pyodideIndexUrl } from './runtime-config';
import { nextRequestId, runTestLoop } from './test-runner';
import type {
  CodeExecutor,
  ExecutionRequest,
  ExecutionResult,
  Language,
  WorkerInitErrorMessage,
  WorkerReadyMessage,
  WorkerResultMessage,
} from './types';
import { ExecutorEnvironmentError, parseWorkerInitReply, parseWorkerResult } from './types';
import type { BridgeOutcome, WorkerFactory } from './worker-bridge';
import { defaultWorkerFactory, WorkerBridge } from './worker-bridge';

/**
 * Generous on purpose. This covers a cold CDN fetch of the Pyodide runtime on
 * a conference-wifi connection; failing it early just turns a slow start into
 * a hard error the candidate cannot retry out of.
 */
const DEFAULT_INIT_TIMEOUT_MS = 90_000;

export interface PythonExecutorOptions {
  workerFactory?: WorkerFactory;
  /** Overrides `NEXT_PUBLIC_PYODIDE_INDEX_URL`; mainly for tests and self-hosting. */
  indexUrl?: string;
  initTimeoutMs?: number;
}

export class PythonExecutor implements CodeExecutor {
  readonly language: Language = 'python';

  readonly #bridge: WorkerBridge;
  readonly #checkCapabilities: boolean;
  readonly #indexUrl: string;
  readonly #initTimeoutMs: number;

  /** Memoised init. Nulled whenever the worker dies so the next call re-inits. */
  #ready: Promise<void> | null = null;

  constructor(options: PythonExecutorOptions = {}) {
    this.#checkCapabilities = options.workerFactory === undefined;
    this.#indexUrl = options.indexUrl ?? pyodideIndexUrl();
    this.#initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.#bridge = new WorkerBridge(
      options.workerFactory ?? defaultWorkerFactory(PY_WORKER_URL, 'interviewlab-py-runner'),
    );
  }

  /** Starts (or joins) the Pyodide download. Rejects with `ExecutorEnvironmentError`. */
  async warmUp(): Promise<void> {
    await this.#ensureReady();
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    // Deliberately outside the loop and allowed to reject: a runtime that
    // never loaded is an environment problem, and the per-test error rows a
    // returned ExecutionResult would produce read as the candidate's fault.
    await this.#ensureReady();

    const sourceCode = request.sourceCode;

    return runTestLoop(request, {
      runTest: async (test, timeoutMs, signal) => {
        // A mid-run re-init (after a timeout killed the interpreter) must not
        // reject the loop — surface it as a fatal outcome for this run instead.
        try {
          await this.#ensureReady();
        } catch (error) {
          return {
            kind: 'worker-error',
            message: error instanceof Error ? error.message : String(error),
          } satisfies BridgeOutcome<WorkerResultMessage>;
        }

        const id = nextRequestId('py');
        return this.#bridge.request<WorkerResultMessage>(
          { type: 'run', id, sourceCode, input: test.input },
          { timeoutMs, signal, match: (data) => parseWorkerResult(data, id) },
        );
      },
      recover: () => {
        // The interpreter died with the worker. Forget the handshake so the
        // next test pays for a fresh `loadPyodide()` rather than posting `run`
        // into a worker that has no Python in it.
        this.#ready = null;
      },
    });
  }

  dispose(): void {
    this.#ready = null;
    this.#bridge.dispose();
  }

  #ensureReady(): Promise<void> {
    if (this.#bridge.wasTerminated) this.#ready = null;
    if (this.#ready) return this.#ready;

    const pending = this.#initialize();
    this.#ready = pending;
    // A transient CDN blip must not be cached as a permanent rejection: the
    // candidate clicking Run again should genuinely retry.
    pending.catch(() => {
      if (this.#ready === pending) this.#ready = null;
    });
    return pending;
  }

  async #initialize(): Promise<void> {
    if (this.#checkCapabilities) assertRuntimeSupport('python');

    const outcome = await this.#bridge.request<WorkerReadyMessage | WorkerInitErrorMessage>(
      { type: 'init', indexUrl: this.#indexUrl },
      { timeoutMs: this.#initTimeoutMs, match: parseWorkerInitReply },
    );

    switch (outcome.kind) {
      case 'message':
        if (outcome.data.type === 'ready') return;
        throw new ExecutorEnvironmentError(
          `The Python runtime could not be loaded: ${outcome.data.message}`,
          { language: 'python' },
        );
      case 'timeout':
        throw new ExecutorEnvironmentError(
          `The Python runtime did not finish loading from ${this.#indexUrl} within ` +
            `${this.#initTimeoutMs}ms. Check the connection, or self-host Pyodide via ` +
            'NEXT_PUBLIC_PYODIDE_INDEX_URL.',
          { language: 'python' },
        );
      case 'aborted':
        throw new ExecutorEnvironmentError('Loading the Python runtime was cancelled.', {
          language: 'python',
        });
      case 'worker-error':
        throw new ExecutorEnvironmentError(
          `The Python worker could not start: ${outcome.message}`,
          { language: 'python' },
        );
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled init outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}
