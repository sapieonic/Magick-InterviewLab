/**
 * Scoring is the number a hiring decision gets made from, so the edges matter
 * more than the happy path: an unconfigured question must not read as 100%,
 * and a nonsense weight must not produce NaN on a scorecard.
 */

import { describe, expect, it } from 'vitest';

import {
  defaultGrader,
  normalizeWeight,
  overallStatus,
  scoreResults,
} from '@/features/execution/scoring';
import type { TestResult, TestStatus } from '@/features/execution/types';

function makeResult(status: TestStatus, weight = 1): TestResult {
  return {
    testCaseId: `t-${status}-${weight}-${Math.random().toString(36).slice(2, 8)}`,
    status,
    input: '',
    expectedOutput: '',
    actualOutput: '',
    weight,
    durationMs: 1,
  };
}

describe('normalizeWeight', () => {
  it('keeps sensible weights as they are', () => {
    expect(normalizeWeight(1)).toBe(1);
    expect(normalizeWeight(3)).toBe(3);
  });

  /**
   * Must match the server's authoritative `scoreSubmission` exactly. The two
   * used to disagree on fractional weights — this one kept 2.5, the server
   * floored it to 2 — so a candidate could be shown a score the transcript
   * would not record. The column is an Int today, which is the only reason
   * that never bit.
   */
  it('floors a fractional weight, agreeing with the server-side scorer', () => {
    expect(normalizeWeight(2.5)).toBe(2);
    expect(normalizeWeight(1.9)).toBe(1);
  });

  it('floors anything below 1 — including the values a bad admin form produces', () => {
    expect(normalizeWeight(0)).toBe(1);
    expect(normalizeWeight(-5)).toBe(1);
    expect(normalizeWeight(0.5)).toBe(1);
    expect(normalizeWeight(Number.NaN)).toBe(1);
    expect(normalizeWeight(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('scoreResults', () => {
  it('scores an all-pass run at 100', () => {
    const summary = scoreResults([makeResult('passed'), makeResult('passed')]);
    expect(summary).toEqual({
      score: 100,
      passed: 2,
      total: 2,
      earnedWeight: 2,
      totalWeight: 2,
    });
  });

  it('scores an all-fail run at 0', () => {
    const summary = scoreResults([makeResult('failed'), makeResult('error')]);
    expect(summary.score).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.total).toBe(2);
  });

  it('weights passing tests rather than counting them', () => {
    // One heavy test passing beats three light ones failing.
    const summary = scoreResults([
      makeResult('passed', 7),
      makeResult('failed', 1),
      makeResult('failed', 1),
      makeResult('failed', 1),
    ]);
    expect(summary.earnedWeight).toBe(7);
    expect(summary.totalWeight).toBe(10);
    expect(summary.score).toBe(70);
    expect(summary.passed).toBe(1);
  });

  it('rounds to the nearest whole percent', () => {
    // 1/3 -> 33.33 -> 33
    expect(
      scoreResults([makeResult('passed'), makeResult('failed'), makeResult('failed')]).score,
    ).toBe(33);
    // 2/3 -> 66.67 -> 67
    expect(
      scoreResults([makeResult('passed'), makeResult('passed'), makeResult('failed')]).score,
    ).toBe(67);
  });

  it('treats a zero or negative weight as 1 instead of dividing by zero', () => {
    const summary = scoreResults([makeResult('passed', 0), makeResult('failed', -4)]);
    expect(summary.totalWeight).toBe(2);
    expect(summary.earnedWeight).toBe(1);
    expect(summary.score).toBe(50);
    expect(Number.isNaN(summary.score)).toBe(false);
  });

  it('scores an empty run at 0, not at 100', () => {
    expect(scoreResults([])).toEqual({
      score: 0,
      passed: 0,
      total: 0,
      earnedWeight: 0,
      totalWeight: 0,
    });
  });

  it('counts only "passed" as earning credit', () => {
    const summary = scoreResults([
      makeResult('passed'),
      makeResult('failed'),
      makeResult('error'),
      makeResult('timeout'),
    ]);
    expect(summary.passed).toBe(1);
    expect(summary.score).toBe(25);
  });
});

describe('overallStatus', () => {
  it('is passed when every test passed', () => {
    expect(overallStatus([makeResult('passed'), makeResult('passed')])).toBe('passed');
  });

  it('is failed for an ordinary wrong answer', () => {
    expect(overallStatus([makeResult('passed'), makeResult('failed')])).toBe('failed');
  });

  it('reports timeout rather than the generic failure', () => {
    expect(overallStatus([makeResult('passed'), makeResult('timeout')])).toBe('timeout');
    expect(overallStatus([makeResult('failed'), makeResult('timeout')])).toBe('timeout');
  });

  it('lets error outrank timeout — it is the more urgent thing to show', () => {
    expect(overallStatus([makeResult('timeout'), makeResult('error')])).toBe('error');
  });

  it('lets error outrank failure', () => {
    expect(overallStatus([makeResult('failed'), makeResult('error')])).toBe('error');
  });

  it('is vacuously passed for an empty list (callers check total === 0)', () => {
    expect(overallStatus([])).toBe('passed');
  });
});

describe('defaultGrader', () => {
  it('is the weighted, all-visible grader and delegates to the pure functions', () => {
    const tests = [makeResult('passed', 2), makeResult('failed', 2)];
    expect(defaultGrader.id).toBe('weighted-all-visible');
    expect(defaultGrader.score(tests)).toEqual(scoreResults(tests));
    expect(defaultGrader.status(tests)).toBe(overallStatus(tests));
  });
});
