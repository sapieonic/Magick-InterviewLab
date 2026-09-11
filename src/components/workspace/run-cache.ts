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

export interface RunSnapshot {
  language: Language;
  sourceCode: string;
  result: ExecutionResult;
  savedAt: number;
}

function storageKey(questionId: string): string {
  return `${STORAGE_PREFIX}.${questionId}`;
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
    window.localStorage.setItem(
      storageKey(questionId),
      JSON.stringify({ ...snapshot, savedAt: Date.now() } satisfies RunSnapshot),
    );
  } catch {
    // Quota (a large run can be MBs) or a locked-down browser. The run simply
    // will not survive a refresh; nothing else depends on it.
  }
}

export function clearRunCache(questionId: string): void {
  try {
    window.localStorage.removeItem(storageKey(questionId));
  } catch {
    // Nothing to do — a stale entry that fails `runMatches` is inert anyway.
  }
}
