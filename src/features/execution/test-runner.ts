/**
 * The per-test loop, shared by both executors.
 *
 * It lives on its own because the *policy* — what a syntax error does to the
 * remaining tests, what an abort looks like in the results array, whether a
 * timeout is fatal — must be identical for JavaScript and Python. When this
 * logic was duplicated per language it drifted within a week: one of them
 * short-circuited on a syntax error and the other re-ran the same broken
 * source twenty times, so the same submission produced two different
 * scorecards depending on the language picked.
 *
 * The executors supply only the transport (`runTest`) and the recovery
 * (`recover`, called after the runtime has been killed).
 */

import { nowMs } from './clock';
import { outputMatches } from './normalize';
import { overallStatus } from './scoring';
import type {
  ExecutionRequest,
  ExecutionResult,
  TestCase,
  TestResult,
  WorkerResultMessage,
} from './types';
import type { BridgeOutcome } from './worker-bridge';

export interface TestLoopHooks {
  /**
   * Run one test case. MUST always resolve — the loop has no rejection path,
   * because a rejection here is a "Running…" state nobody can clear.
   */
  runTest(
    test: TestCase,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<BridgeOutcome<WorkerResultMessage>>;
  /**
   * Called after any outcome that killed the runtime (timeout, abort, worker
   * error), so the executor can drop cached state. JavaScript respawns
   * lazily and does nothing here; Python has to re-download Pyodide.
   */
  recover?(): void;
}

function baseResult(test: TestCase): Omit<TestResult, 'status'> {
  return {
    testCaseId: test.id,
    description: test.description,
    input: test.input,
    expectedOutput: test.expectedOutput,
    // Raw, not normalised: the candidate should see exactly what their program
    // printed. Normalisation is a comparison rule, not a display rule.
    actualOutput: '',
    weight: test.weight,
    durationMs: 0,
  };
}

export async function runTestLoop(
  request: ExecutionRequest,
  hooks: TestLoopHooks,
): Promise<ExecutionResult> {
  const startedAt = nowMs();
  const total = request.tests.length;
  const results: TestResult[] = [];

  /** Set once something makes every remaining test pointless (syntax error, dead worker). */
  let fatalError: string | undefined;
  let cancelled = false;

  for (const test of request.tests) {
    if (cancelled) {
      results.push({
        ...baseResult(test),
        status: 'error',
        errorKind: 'internal',
        errorMessage: 'Run cancelled before this test executed.',
      });
      request.onProgress?.(results.length, total);
      continue;
    }

    if (fatalError !== undefined) {
      // Re-running the same unparseable source N times produces N identical
      // errors and N spinner ticks; report it once per test and move on.
      results.push({
        ...baseResult(test),
        status: 'error',
        errorKind: 'syntax',
        errorMessage: fatalError,
      });
      request.onProgress?.(results.length, total);
      continue;
    }

    if (request.signal?.aborted) {
      cancelled = true;
      results.push({
        ...baseResult(test),
        status: 'error',
        errorKind: 'internal',
        errorMessage: 'Run cancelled before this test executed.',
      });
      request.onProgress?.(results.length, total);
      continue;
    }

    const testStartedAt = nowMs();
    const outcome = await hooks.runTest(test, request.timeoutMs, request.signal);
    const wallMs = nowMs() - testStartedAt;

    switch (outcome.kind) {
      case 'message': {
        const data = outcome.data;
        const durationMs = data.durationMs > 0 ? data.durationMs : wallMs;
        const common = {
          ...baseResult(test),
          actualOutput: data.stdout,
          stderr: data.stderr === '' ? undefined : data.stderr,
          durationMs,
        };

        if (data.error !== undefined && data.errorKind === 'syntax') {
          fatalError = data.error;
          results.push({
            ...common,
            status: 'error',
            errorKind: 'syntax',
            errorMessage: data.error,
          });
        } else if (data.error !== undefined) {
          results.push({
            ...common,
            status: 'error',
            errorKind: data.errorKind ?? 'runtime',
            errorMessage: data.error,
          });
        } else {
          results.push({
            ...common,
            status: outputMatches(data.stdout, test.expectedOutput) ? 'passed' : 'failed',
          });
        }
        break;
      }

      case 'timeout': {
        // The runtime has already been terminated by the bridge — that is the
        // only way to stop a runaway loop. Everything cached inside it is gone.
        hooks.recover?.();
        results.push({
          ...baseResult(test),
          status: 'timeout',
          errorKind: 'timeout',
          durationMs: outcome.elapsedMs,
          errorMessage:
            `Execution timed out after ${request.timeoutMs}ms. ` +
            'The runtime was stopped; check for an infinite loop or an algorithm that is too slow.',
        });
        break;
      }

      case 'aborted': {
        hooks.recover?.();
        cancelled = true;
        results.push({
          ...baseResult(test),
          status: 'error',
          errorKind: 'internal',
          durationMs: wallMs,
          errorMessage: 'Run cancelled.',
        });
        break;
      }

      case 'worker-error': {
        // The worker script 404'd, was blocked by CSP, or crashed. Every
        // remaining test would fail the same way, so stop asking.
        hooks.recover?.();
        fatalError = outcome.message;
        results.push({
          ...baseResult(test),
          status: 'error',
          errorKind: 'internal',
          durationMs: wallMs,
          errorMessage: outcome.message,
        });
        break;
      }

      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled bridge outcome: ${JSON.stringify(exhaustive)}`);
      }
    }

    request.onProgress?.(results.length, total);
  }

  // Convenience aggregate for the single-test "Run" button, which is by far
  // the most common way this is called. With many tests it is a concatenation,
  // and the per-test `actualOutput` is what a results table should render.
  const stdout = results
    .map((r) => r.actualOutput)
    .filter((s) => s.length > 0)
    .join('\n');
  const stderr = results
    .map((r) => r.stderr ?? '')
    .filter((s) => s.length > 0)
    .join('\n');

  const result: ExecutionResult = {
    status: overallStatus(results),
    tests: results,
    executionTimeMs: nowMs() - startedAt,
  };
  if (stdout.length > 0) result.stdout = stdout;
  if (stderr.length > 0) result.stderr = stderr;
  if (fatalError !== undefined) result.fatalError = fatalError;
  return result;
}

let sequence = 0;

/** Correlation ids only need to be unique within one worker's lifetime. */
export function nextRequestId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}
