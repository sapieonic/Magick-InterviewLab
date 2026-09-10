/**
 * Turning a list of test results into a number a human will argue about.
 *
 * Pure and dependency-free on purpose: this is the one piece of the pipeline
 * that must produce the identical answer whether it runs in the candidate's
 * browser (optimistic UI), in the reviewer's browser (replay), or on the server
 * once the remote sandbox lands. Anything that reaches for `Date`, the DOM or
 * the network does not belong here.
 *
 * The `Grader` seam is not speculative generality — hidden tests
 * (`TestCase.isHidden` already exists in the Prisma schema), partial credit for
 * "compiles but fails edge cases", and per-question custom graders are all on
 * the roadmap, and every one of them is a different `score()`/`status()` pair
 * over the same `TestResult[]`.
 */

import type { ExecutionStatus, TestResult } from './types';

export interface ScoreSummary {
  /** 0-100, rounded. */
  score: number;
  passed: number;
  total: number;
  /** Sum of normalised weights of passing tests. */
  earnedWeight: number;
  /** Sum of normalised weights of all tests. */
  totalWeight: number;
}

export interface Grader {
  readonly id: string;
  score(tests: readonly TestResult[]): ScoreSummary;
  status(tests: readonly TestResult[]): ExecutionStatus;
}

/**
 * A weight below 1 (or NaN, or Infinity, or a negative left by a careless
 * admin form) is coerced to 1. The alternative — dividing by a zero or negative
 * total — produces `NaN%` or a negative score on the candidate's screen, which
 * is a support ticket rather than a grading decision.
 */
export function normalizeWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight < 1) return 1;
  return weight;
}

export function scoreResults(tests: readonly TestResult[]): ScoreSummary {
  let earnedWeight = 0;
  let totalWeight = 0;
  let passed = 0;

  for (const test of tests) {
    const weight = normalizeWeight(test.weight);
    totalWeight += weight;
    if (test.status === 'passed') {
      passed += 1;
      earnedWeight += weight;
    }
  }

  // No tests is not a perfect score. An unconfigured question must not read as
  // 100% on a scorecard someone makes a hiring decision from.
  const score = totalWeight > 0 ? Math.round((100 * earnedWeight) / totalWeight) : 0;

  return { score, passed, total: tests.length, earnedWeight, totalWeight };
}

/**
 * Precedence: error beats timeout beats failure.
 *
 * A timeout is a specific, actionable message ("your solution is too slow"),
 * so it must not be swallowed by a generic "failed". But if anything actually
 * errored — a syntax error, an exception, an internal fault — that is the more
 * urgent thing to show, so it wins outright.
 *
 * An empty list is vacuously 'passed' (`[].every(...)` is `true`). Callers that
 * care about the difference between "everything passed" and "there was nothing
 * to run" should check `scoreResults().total === 0`; encoding that distinction
 * in the status enum would mean a fifth state every switch has to handle.
 */
export function overallStatus(tests: readonly TestResult[]): ExecutionStatus {
  if (tests.every((t) => t.status === 'passed')) return 'passed';
  if (tests.some((t) => t.status === 'error')) return 'error';
  if (tests.some((t) => t.status === 'timeout')) return 'timeout';
  return 'failed';
}

export const defaultGrader: Grader = {
  id: 'weighted-all-visible',
  score: scoreResults,
  status: overallStatus,
};
