import { describe, expect, it } from 'vitest';

import {
  scoreLabel,
  scoreSubmission,
  type ScorableResult,
  type WeightedTest,
} from '@/features/submissions/score';

const tests = (...weights: number[]): WeightedTest[] =>
  weights.map((weight, index) => ({ id: `t${index + 1}`, weight }));

const passed = (...ids: string[]): ScorableResult[] =>
  ids.map((testCaseId) => ({ testCaseId, status: 'passed' }));

describe('scoreSubmission', () => {
  it('awards 100 when every authoritative test passed', () => {
    const result = scoreSubmission(tests(1, 1, 1), passed('t1', 't2', 't3'));
    expect(result).toEqual({ score: 100, passed: 3, total: 3, earnedWeight: 3, totalWeight: 3 });
  });

  it('awards 0 when nothing passed', () => {
    const reported: ScorableResult[] = [
      { testCaseId: 't1', status: 'failed' },
      { testCaseId: 't2', status: 'error' },
      { testCaseId: 't3', status: 'timeout' },
    ];
    const result = scoreSubmission(tests(1, 1, 1), reported);
    expect(result.score).toBe(0);
    expect(result.passed).toBe(0);
  });

  it('gives weighted partial credit rather than a pass count', () => {
    // t1 is worth 3 of 6 total weight, so passing it alone is 50% even though
    // only one of three tests passed.
    const result = scoreSubmission(tests(3, 2, 1), passed('t1'));
    expect(result).toEqual({ score: 50, passed: 1, total: 3, earnedWeight: 3, totalWeight: 6 });
  });

  it('rounds to the nearest whole percent', () => {
    // 1 of 3 equal weights = 33.33…
    expect(scoreSubmission(tests(1, 1, 1), passed('t1')).score).toBe(33);
    // 2 of 3 = 66.66…
    expect(scoreSubmission(tests(1, 1, 1), passed('t1', 't2')).score).toBe(67);
  });

  it('returns 0 for a question with no test cases instead of dividing by zero', () => {
    expect(scoreSubmission([], passed('t1'))).toEqual({
      score: 0,
      passed: 0,
      total: 0,
      earnedWeight: 0,
      totalWeight: 0,
    });
  });

  // An admin who typed 0 (or a negative, or a fraction) must not be able to
  // silently remove a test from the denominator.
  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional below one', 0.4],
    ['not a number', Number.NaN],
  ])('clamps a %s weight up to 1', (_label, weight) => {
    const result = scoreSubmission([{ id: 't1', weight }], []);
    expect(result.totalWeight).toBe(1);
  });

  it('floors a fractional weight above one', () => {
    const result = scoreSubmission([{ id: 't1', weight: 2.9 }], passed('t1'));
    expect(result.earnedWeight).toBe(2);
    expect(result.totalWeight).toBe(2);
  });

  /**
   * Anti-tamper property #1. The browser runs the tests, so a candidate can
   * drop results from the payload. An omitted test must count as not passed —
   * otherwise deleting the failures from the request would score 100.
   */
  it('counts a test the client omitted as not passed', () => {
    const result = scoreSubmission(tests(1, 1, 1), passed('t1'));
    expect(result.score).toBe(33);
    expect(result.passed).toBe(1);
    expect(result.total).toBe(3);
  });

  /**
   * Anti-tamper property #2. The authoritative list comes from the database;
   * a result naming a test id that is not in it is ignored entirely. It can
   * neither earn weight nor enlarge the denominator, so padding the payload
   * with invented passes cannot move the score.
   */
  it('ignores a reported test id that is not in the authoritative list', () => {
    const authoritative = tests(1, 1);
    const honest = scoreSubmission(authoritative, passed('t1'));
    const padded = scoreSubmission(
      authoritative,
      passed('t1', 'not-a-real-test', 'another-fake', 't99'),
    );

    expect(padded).toEqual(honest);
    expect(padded.score).toBe(50);
  });

  it('ignores an invented id even when it would otherwise be the only pass', () => {
    const result = scoreSubmission(tests(1, 1), passed('injected'));
    expect(result.score).toBe(0);
    expect(result.passed).toBe(0);
  });

  // Weights ride along in the client payload too, but only the database's
  // copy is consulted — this pins that the reported shape has no weight input.
  it('uses the authoritative weights, not anything the client could send', () => {
    const heavy = scoreSubmission(
      [
        { id: 't1', weight: 99 },
        { id: 't2', weight: 1 },
      ],
      passed('t2'),
    );
    expect(heavy.score).toBe(1);
  });

  it('takes the last verdict when the client reports a test twice', () => {
    const reported: ScorableResult[] = [
      { testCaseId: 't1', status: 'passed' },
      { testCaseId: 't1', status: 'failed' },
    ];
    expect(scoreSubmission(tests(1), reported).score).toBe(0);
  });
});

describe('scoreLabel', () => {
  it.each([
    [100, 'strong'],
    [80, 'strong'],
    [79, 'partial'],
    [40, 'partial'],
    [39, 'weak'],
    [0, 'weak'],
  ])('labels %i as %s', (score, label) => {
    expect(scoreLabel(score)).toBe(label);
  });
});
