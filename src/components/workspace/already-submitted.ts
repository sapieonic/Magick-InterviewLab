import type { SubmissionView } from '@/features/submissions/view-model';

/** What the already-submitted dialog describes. */
export interface RecordedAttempt {
  score: number;
  passed: number;
  total: number;
  /** Epoch millis, or null for an attempt made in this session. */
  submittedAt: number | null;
}

/** A submission recorded by this mount, before the server data catches up. */
export interface SessionRecord {
  score: number;
  passed: number;
  total: number;
}

/**
 * Pick the attempt to show a candidate who pressed Submit on a question they
 * have already submitted.
 *
 * Pure and separate for the same reason as `shouldAutoSubmit`: the ordering
 * rule is the subtle part and does not want to be buried in a render.
 *
 * This session's record wins over the stored rows. `createSubmissionAction`
 * returns the score the *server* recorded, but `router.refresh()` resolves
 * afterwards — so in the window between the two, the stored list is either
 * empty or still showing the previous attempt, and preferring it would tell a
 * candidate their brand-new submission scored whatever the old one did. The
 * cost is a null timestamp, which the dialog omits rather than invents.
 */
export function describeLastAttempt(
  recorded: SessionRecord | null,
  submissions: readonly SubmissionView[],
): RecordedAttempt | null {
  if (recorded) {
    return {
      score: recorded.score,
      passed: recorded.passed,
      total: recorded.total,
      submittedAt: null,
    };
  }
  // `getWorkspace` orders by `submittedAt` desc, so index 0 is the latest.
  const latest = submissions[0];
  if (!latest) return null;
  return {
    score: latest.score,
    passed: latest.passedCount,
    total: latest.totalCount,
    submittedAt: latest.submittedAt,
  };
}

/**
 * Whether a further submission is closed off for this question.
 *
 * `recorded` is part of the test, not just `submissions`: between a submit and
 * the refresh that follows it, the stored list has not caught up — and that
 * window is exactly when a candidate is most likely to press the button again.
 */
export function isAlreadySubmitted(
  allowMultipleSubmissions: boolean,
  submissions: readonly SubmissionView[],
  recorded: SessionRecord | null,
): boolean {
  if (allowMultipleSubmissions) return false;
  return submissions.length > 0 || recorded !== null;
}
