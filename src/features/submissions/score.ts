/**
 * Server-side scoring.
 *
 * The browser runs the tests, so the browser is the only thing that *can*
 * report results — but it is not trusted to report a score. The server
 * recomputes the score from the per-test verdicts against the weights it
 * holds in the database, and ignores any weight the client sent. A candidate
 * who tampers with the payload can still lie about which tests passed (that
 * is the documented MVP limitation, closed by the future remote executor),
 * but cannot invent a 100% out of a payload that says three tests failed.
 *
 * Kept pure and dependency-free so it is trivially testable and so a future
 * grader (partial credit, code quality, AI review) can compose with it.
 */

export type TestVerdict = 'passed' | 'failed' | 'error' | 'timeout';

export interface ScorableResult {
  testCaseId: string;
  status: TestVerdict;
}

export interface WeightedTest {
  id: string;
  weight: number;
}

export interface ScoreBreakdown {
  score: number;
  passed: number;
  total: number;
  earnedWeight: number;
  totalWeight: number;
}

/** A weight below 1 would let an admin silently zero out a test. */
function safeWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 1;
  return Math.max(1, Math.floor(weight));
}

export function scoreSubmission(
  authoritativeTests: readonly WeightedTest[],
  reported: readonly ScorableResult[],
): ScoreBreakdown {
  const total = authoritativeTests.length;
  if (total === 0) return { score: 0, passed: 0, total: 0, earnedWeight: 0, totalWeight: 0 };

  const verdicts = new Map<string, TestVerdict>();
  for (const r of reported) verdicts.set(r.testCaseId, r.status);

  let earnedWeight = 0;
  let totalWeight = 0;
  let passed = 0;

  for (const test of authoritativeTests) {
    const weight = safeWeight(test.weight);
    totalWeight += weight;
    // A test the client simply omitted counts as not passed.
    if (verdicts.get(test.id) === 'passed') {
      earnedWeight += weight;
      passed += 1;
    }
  }

  const score = totalWeight === 0 ? 0 : Math.round((100 * earnedWeight) / totalWeight);
  return { score, passed, total, earnedWeight, totalWeight };
}

export function scoreLabel(score: number): 'strong' | 'partial' | 'weak' {
  if (score >= 80) return 'strong';
  if (score >= 40) return 'partial';
  return 'weak';
}
