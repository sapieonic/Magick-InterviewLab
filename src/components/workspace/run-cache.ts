'use client';

import type { ExecutionResult, Language } from '@/features/execution/types';

/**
 * Persist the last *completed* test run for a question in this browser, so a
 * refresh restores the results panel instead of blanking it. Only the code
 * draft survived a reload before; the run the candidate was looking at did not,
 * which read as "my results vanished". This is the local half of that fix — it
 * never leaves the browser and is keyed per question.
 *
 * The stored `sourceCode`/`language` are what let the restored run be treated
 * as reusable on submit only while the buffer still matches (`runMatches`), so
 * a refresh can never turn a stale green run into a submittable one.
 */

const STORAGE_PREFIX = 'ilab.run.v1';

// Field caps mirror the submission payload (`createSubmissionSchema`), and a
// hard ceiling on the whole serialized entry so a verbose run can never crowd
// out the draft mirror — the *critical* resilience path — in the ~5MB origin
// quota. A run that is still too big after clipping is simply not cached.
const MAX_FIELD = 20_000;
const MAX_ERROR = 4_000;
const MAX_CACHE_BYTES = 1_000_000;

export interface RunSnapshot {
  language: Language;
  sourceCode: string;
  result: ExecutionResult;
  savedAt: number;
}

function storageKey(questionId: string): string {
  return `${STORAGE_PREFIX}.${questionId}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * A size-bounded copy of a run result for local caching. Per-test output can be
 * hundreds of KB each; unclipped, a single cached run could fill the origin's
 * localStorage quota and make the next `writeLocalDraft` throw — silently
 * disabling the draft mirror, which is the one write that must never fail.
 */
export function clipResultForCache(result: ExecutionResult): ExecutionResult {
  return {
    status: result.status,
    executionTimeMs: result.executionTimeMs,
    fatalError: result.fatalError ? clip(result.fatalError, MAX_ERROR) : undefined,
    stdout: result.stdout ? clip(result.stdout, MAX_FIELD) : undefined,
    stderr: result.stderr ? clip(result.stderr, MAX_FIELD) : undefined,
    tests: result.tests.map((test) => ({
      testCaseId: test.testCaseId,
      description: test.description,
      status: test.status,
      input: clip(test.input, MAX_FIELD),
      expectedOutput: clip(test.expectedOutput, MAX_FIELD),
      actualOutput: clip(test.actualOutput, MAX_FIELD),
      stderr: test.stderr ? clip(test.stderr, MAX_FIELD) : undefined,
      errorMessage: test.errorMessage ? clip(test.errorMessage, MAX_ERROR) : undefined,
      errorKind: test.errorKind,
      weight: test.weight,
      durationMs: test.durationMs,
    })),
  };
}

/**
 * Parse a stored snapshot defensively. A shape that does not at least carry a
 * `tests` array is treated as absent rather than trusted — a corrupt or
 * older-format entry must never crash the workspace on load.
 */
export function decodeRunSnapshot(raw: string): RunSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const { language, sourceCode, savedAt, result } = record;
  if (language !== 'javascript' && language !== 'python') return null;
  if (typeof sourceCode !== 'string') return null;
  if (typeof savedAt !== 'number') return null;
  if (typeof result !== 'object' || result === null) return null;
  if (!Array.isArray((result as Record<string, unknown>).tests)) return null;

  return { language, sourceCode, savedAt, result: result as ExecutionResult };
}

export function readRunCache(questionId: string): RunSnapshot | null {
  try {
    const raw = window.localStorage.getItem(storageKey(questionId));
    return raw === null ? null : decodeRunSnapshot(raw);
  } catch {
    // Private mode / storage disabled — treat as no cached run.
    return null;
  }
}

export function writeRunCache(
  questionId: string,
  snapshot: Pick<RunSnapshot, 'language' | 'sourceCode' | 'result'>,
): void {
  try {
    const payload = JSON.stringify({
      language: snapshot.language,
      sourceCode: snapshot.sourceCode,
      result: clipResultForCache(snapshot.result),
      savedAt: Date.now(),
    } satisfies RunSnapshot);
    // A run too large even after clipping is dropped rather than risking the
    // quota that the draft mirror depends on.
    if (payload.length > MAX_CACHE_BYTES) return;
    window.localStorage.setItem(storageKey(questionId), payload);
  } catch {
    // Quota or a locked-down browser. The run simply will not survive a
    // refresh; nothing else depends on it.
  }
}
