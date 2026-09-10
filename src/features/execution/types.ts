/**
 * The execution contract.
 *
 * Everything here is deliberately transport-agnostic. Today candidate code runs
 * in a Web Worker in the candidate's own browser; tomorrow the same shapes are
 * meant to travel over the wire to a server-side sandbox. That is why the model
 * is the lowest common denominator both can honour: **stdin in, stdout out**.
 * No "call the function named twoSum with these args" — that couples the grader
 * to a language's calling convention and dies the moment you add a third
 * language. A test case is a string fed to stdin and a string compared against
 * trimmed stdout, which is exactly what a container running `python main.py`
 * gives you for free.
 *
 * The worker message shapes live here too, next to the types they serialise, so
 * a change to `public/workers/*.js` and a change to the TypeScript side are one
 * diff apart instead of one directory apart.
 */

export type Language = 'javascript' | 'python';
export type TestStatus = 'passed' | 'failed' | 'error' | 'timeout';
export type ExecutionStatus = 'passed' | 'failed' | 'error' | 'timeout';

/**
 * Why the caller cares about the distinction: a syntax error is fatal for the
 * whole run (every remaining test would fail identically, so we short-circuit),
 * a runtime error is per-test, a timeout means we killed the worker and must
 * respawn, and `internal` means we broke — not the candidate.
 */
export type ErrorKind = 'syntax' | 'runtime' | 'timeout' | 'internal';

export interface TestCase {
  id: string;
  input: string;
  expectedOutput: string;
  description?: string;
  weight: number;
}

export interface TestResult {
  testCaseId: string;
  description?: string;
  status: TestStatus;
  input: string;
  expectedOutput: string;
  actualOutput: string;
  stderr?: string;
  /** Human-readable: syntax error, runtime error, timeout. */
  errorMessage?: string;
  errorKind?: ErrorKind;
  weight: number;
  durationMs: number;
}

export interface ExecutionRequest {
  language: Language;
  sourceCode: string;
  tests: TestCase[];
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  tests: TestResult[];
  stdout?: string;
  stderr?: string;
  executionTimeMs?: number;
  /** Set when the whole run failed before/independently of individual tests. */
  fatalError?: string;
}

export interface CodeExecutor {
  readonly language: Language;
  /** Load the runtime. Safe to call repeatedly. */
  warmUp?(): Promise<void>;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  dispose(): void;
}

/**
 * What the browser can actually do. Pyodide needs WebAssembly; both executors
 * need Workers. Detecting this up front is the difference between "Python is
 * not available in this browser — try Chrome or Firefox" and a candidate
 * staring at a spinner during a timed interview.
 */
export interface RuntimeCapabilities {
  webAssembly: boolean;
  webWorker: boolean;
  ok: boolean;
  reason?: string;
}

/**
 * The environment is broken, not the candidate's code. Kept separate from a
 * plain Error so the UI can say "the Python runtime could not be downloaded"
 * instead of blaming a submission — a distinction that matters a great deal
 * when someone is being graded on the result.
 */
export class ExecutorEnvironmentError extends Error {
  readonly language: Language | undefined;

  constructor(message: string, options?: { language?: Language; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ExecutorEnvironmentError';
    this.language = options?.language;
  }
}

/* -------------------------------------------------------------------------- */
/* Worker protocol                                                            */
/* -------------------------------------------------------------------------- */

/** Host -> python worker. Sent once; the runner caches Pyodide afterwards. */
export interface WorkerInitMessage {
  type: 'init';
  indexUrl: string;
}

/** Host -> worker. `id` correlates the reply; see `worker-bridge.ts`. */
export interface WorkerRunMessage {
  type: 'run';
  id: string;
  sourceCode: string;
  input: string;
}

export type WorkerInboundMessage = WorkerInitMessage | WorkerRunMessage;

export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerInitErrorMessage {
  type: 'init-error';
  message: string;
}

export interface WorkerResultMessage {
  type: 'result';
  id: string;
  stdout: string;
  stderr: string;
  error?: string;
  errorKind?: ErrorKind;
  durationMs: number;
}

export type WorkerOutboundMessage =
  | WorkerReadyMessage
  | WorkerInitErrorMessage
  | WorkerResultMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isErrorKind(value: unknown): value is ErrorKind {
  return (
    value === 'syntax' || value === 'runtime' || value === 'timeout' || value === 'internal'
  );
}

/**
 * Structured-clone hands us `unknown`. Narrow rather than cast: a worker that
 * posts a malformed message should look like "no reply" (and hit the timeout)
 * rather than producing a `TestResult` full of `undefined`.
 */
export function parseWorkerResult(data: unknown, id: string): WorkerResultMessage | null {
  if (!isRecord(data)) return null;
  if (data['type'] !== 'result' || data['id'] !== id) return null;
  const errorKind = data['errorKind'];
  return {
    type: 'result',
    id,
    stdout: typeof data['stdout'] === 'string' ? data['stdout'] : '',
    stderr: typeof data['stderr'] === 'string' ? data['stderr'] : '',
    error: optionalString(data['error']),
    errorKind: isErrorKind(errorKind) ? errorKind : undefined,
    durationMs: typeof data['durationMs'] === 'number' ? data['durationMs'] : 0,
  };
}

export function parseWorkerInitReply(
  data: unknown,
): WorkerReadyMessage | WorkerInitErrorMessage | null {
  if (!isRecord(data)) return null;
  if (data['type'] === 'ready') return { type: 'ready' };
  if (data['type'] === 'init-error') {
    return { type: 'init-error', message: optionalString(data['message']) ?? 'Unknown error' };
  }
  return null;
}
