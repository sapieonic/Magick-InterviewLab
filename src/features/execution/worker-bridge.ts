/**
 * A typed request/response wrapper around a Worker.
 *
 * ## Why the hard timeout is the whole point of this file
 *
 * `while (true) {}` in a Web Worker cannot be interrupted. There is no
 * cooperative cancellation, no signal, no `AbortController` that reaches inside
 * the worker's event loop — the worker never returns to it. `Worker.terminate()`
 * is the *only* mechanism a browser gives you to stop it, and it is
 * unconditional and irreversible.
 *
 * So the contract here is: every request carries a deadline; when the deadline
 * fires we terminate the worker and resolve the caller with `{ kind: 'timeout' }`.
 * The bridge then reports itself dead and the next `request()` spawns a fresh
 * worker. Callers must never `await` a worker reply without going through this
 * class, or a candidate's infinite loop becomes a permanently stuck "Running…".
 *
 * (Pyodide has a second option — `SharedArrayBuffer`-based interrupts — but
 * that needs cross-origin isolation headers on the whole app. Terminate-and-
 * respawn costs a Pyodide reload, which is why `PythonExecutor` treats a
 * timeout as expensive and JavaScript treats it as free.)
 *
 * ## Why `WorkerLike` instead of `Worker`
 *
 * Tests run in Node, which has no DOM `Worker`, and spinning up a real one to
 * assert "we terminated on timeout" would be slow and racy. The factory is
 * injectable and typed against the three members we actually use, so a
 * ~40-line fake satisfies it. A real `Worker` is structurally assignable —
 * `defaultWorkerFactory` below is the compile-time proof.
 */

import { nowMs } from './clock';

/** The parts of `MessageEvent` / `ErrorEvent` this bridge reads. */
export interface WorkerEventLike {
  readonly data?: unknown;
  readonly message?: string;
}

export type WorkerEventName = 'message' | 'error' | 'messageerror';

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: WorkerEventName, listener: (event: WorkerEventLike) => void): void;
  removeEventListener(type: WorkerEventName, listener: (event: WorkerEventLike) => void): void;
}

export type WorkerFactory = () => WorkerLike;

export type BridgeOutcome<T> =
  | { kind: 'message'; data: T }
  | { kind: 'timeout'; elapsedMs: number }
  | { kind: 'aborted' }
  | { kind: 'worker-error'; message: string };

export interface RequestOptions<T> {
  /** Deadline in ms. On expiry the worker is terminated — see the file header. */
  timeoutMs: number;
  /**
   * Narrows an inbound message to the reply we are waiting for. Returning
   * `null` means "not mine" — other messages keep flowing to other waiters.
   */
  match: (data: unknown) => T | null;
  signal?: AbortSignal;
}

interface Waiter {
  match: (data: unknown) => unknown;
  settle: (outcome: BridgeOutcome<never>) => void;
  cleanup: () => void;
}

export class WorkerBridge {
  readonly #createWorker: WorkerFactory;
  #worker: WorkerLike | null = null;
  #waiters = new Set<Waiter>();
  #disposed = false;

  /** Sticky: a terminated worker's runtime state is gone, callers may need to re-init. */
  #wasTerminated = false;

  constructor(createWorker: WorkerFactory) {
    this.#createWorker = createWorker;
  }

  get isAlive(): boolean {
    return this.#worker !== null;
  }

  /**
   * True once a worker has been killed (timeout, abort, explicit terminate) and
   * not yet replaced. `PythonExecutor` reads this to know its Pyodide instance
   * died with it and must be re-initialised.
   */
  get wasTerminated(): boolean {
    return this.#wasTerminated;
  }

  /** Spawns on first use. Throws whatever the factory throws (e.g. a CSP failure). */
  ensureWorker(): WorkerLike {
    if (this.#disposed) throw new Error('WorkerBridge has been disposed');
    if (this.#worker) return this.#worker;

    const worker = this.#createWorker();
    worker.addEventListener('message', this.#onMessage);
    worker.addEventListener('error', this.#onError);
    worker.addEventListener('messageerror', this.#onError);
    this.#worker = worker;
    this.#wasTerminated = false;
    return worker;
  }

  /** Fire-and-forget. Used for the Python `init` handshake's outbound half. */
  post(message: unknown): void {
    this.ensureWorker().postMessage(message);
  }

  /**
   * Send, then wait for a matching reply. Always resolves — never rejects —
   * so a caller can render *something* for every outcome. "Never leave a
   * Running… state unresolvable" is enforced here.
   */
  request<T>(message: unknown, options: RequestOptions<T>): Promise<BridgeOutcome<T>> {
    const startedAt = nowMs();

    return new Promise<BridgeOutcome<T>>((resolve) => {
      let settled = false;
      // Boxed because `cleanup` closes over it before the deadline is armed.
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};

      const waiter: Waiter = {
        match: options.match as (data: unknown) => unknown,
        settle: (outcome) => {
          if (settled) return;
          settled = true;
          waiter.cleanup();
          resolve(outcome as BridgeOutcome<T>);
        },
        cleanup: () => {
          if (deadline.timer !== undefined) clearTimeout(deadline.timer);
          this.#waiters.delete(waiter);
          if (options.signal) options.signal.removeEventListener('abort', onAbort);
        },
      };

      const onAbort = (): void => {
        // Settle BEFORE terminating. `terminate()` fails every outstanding
        // waiter with a generic "Worker terminated", so killing first turns
        // this cancellation into an indistinguishable worker error — and a
        // cancelled run then reads as a crash. Settling first removes this
        // waiter from the set, so the kill only reaches genuine bystanders.
        waiter.settle({ kind: 'aborted' });
        // The worker may be mid-infinite-loop and will never observe a flag,
        // so killing it is the only cancel that actually works.
        this.terminate();
      };

      if (options.signal?.aborted) {
        resolve({ kind: 'aborted' });
        return;
      }
      options.signal?.addEventListener('abort', onAbort);

      this.#waiters.add(waiter);

      let worker: WorkerLike;
      try {
        worker = this.ensureWorker();
      } catch (error) {
        waiter.settle({
          kind: 'worker-error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      deadline.timer = setTimeout(() => {
        // Settle first, terminate second — see `onAbort` above. Reversed, a
        // timeout is reported as a generic worker error, the test loop treats
        // it as fatal, and every remaining test is skipped instead of running
        // on a fresh worker.
        waiter.settle({ kind: 'timeout', elapsedMs: nowMs() - startedAt });
        this.terminate();
      }, options.timeoutMs);

      try {
        worker.postMessage(message);
      } catch (error) {
        waiter.settle({
          kind: 'worker-error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** Kills the worker. Outstanding waiters that have not settled resolve as errors. */
  terminate(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;

    this.#wasTerminated = true;
    worker.removeEventListener('message', this.#onMessage);
    worker.removeEventListener('error', this.#onError);
    worker.removeEventListener('messageerror', this.#onError);
    try {
      worker.terminate();
    } catch {
      // A fake or already-dead worker; nothing useful to do.
    }
    this.#failAllWaiters('Worker terminated');
  }

  dispose(): void {
    this.#disposed = true;
    this.terminate();
  }

  #onMessage = (event: WorkerEventLike): void => {
    // Snapshot: a waiter settling mutates the set we are iterating.
    for (const waiter of [...this.#waiters]) {
      const matched = waiter.match(event.data);
      if (matched !== null && matched !== undefined) {
        waiter.settle({ kind: 'message', data: matched } as BridgeOutcome<never>);
        return;
      }
    }
  };

  #onError = (event: WorkerEventLike): void => {
    const message =
      typeof event.message === 'string' && event.message.length > 0
        ? event.message
        : 'The execution worker failed to start or crashed.';
    // Report the specific failure before `terminate()` can overwrite it with
    // the generic "Worker terminated"; the worker's state is unknowable after
    // an uncaught error, so it still has to go.
    this.#failAllWaiters(message);
    this.terminate();
  };

  #failAllWaiters(message: string): void {
    for (const waiter of [...this.#waiters]) {
      waiter.settle({ kind: 'worker-error', message } as BridgeOutcome<never>);
    }
    this.#waiters.clear();
  }
}

/**
 * The real browser factory. Classic (not module) workers on purpose: the
 * Python runner calls `importScripts()` to pull in Pyodide, which module
 * workers forbid.
 *
 * This function is also the type-level assertion that a DOM `Worker` satisfies
 * `WorkerLike` — if that ever stops being true, this line stops compiling.
 */
export function defaultWorkerFactory(scriptUrl: string, name: string): WorkerFactory {
  return () => new Worker(scriptUrl, { type: 'classic', name });
}
