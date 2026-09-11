import { describe, expect, it } from 'vitest';

import {
  describeLastAttempt,
  isAlreadySubmitted,
  type SessionRecord,
} from '@/components/workspace/already-submitted';
import type { SubmissionView } from '@/features/submissions/view-model';

function stored(overrides: Partial<SubmissionView> = {}): SubmissionView {
  return {
    id: 'sub-1',
    language: 'javascript',
    score: 60,
    passedCount: 3,
    totalCount: 5,
    submittedAt: Date.UTC(2026, 2, 9, 10, 30),
    ...overrides,
  };
}

const session: SessionRecord = { score: 100, passed: 5, total: 5 };

/**
 * The flag decides whether pressing Submit submits or explains. Getting it
 * wrong in either direction is bad in a different way: too eager and a
 * candidate on a multi-attempt interview is told they cannot try again; too
 * lax and a one-attempt question quietly takes a second row.
 */
describe('isAlreadySubmitted', () => {
  it('never blocks an interview that allows multiple submissions', () => {
    expect(isAlreadySubmitted(true, [stored()], session)).toBe(false);
  });

  it('does not block a one-attempt question that has no submission yet', () => {
    expect(isAlreadySubmitted(false, [], null)).toBe(false);
  });

  it('blocks once a submission is stored', () => {
    expect(isAlreadySubmitted(false, [stored()], null)).toBe(true);
  });

  /**
   * The window this exists for: `createSubmissionAction` has returned but
   * `router.refresh()` has not, so the stored list is still empty. Without
   * the session record the button would be live again for exactly as long as
   * that refresh takes — the moment a candidate is most likely to press it.
   */
  it('blocks on this session’s record before the server data catches up', () => {
    expect(isAlreadySubmitted(false, [], session)).toBe(true);
  });
});

describe('describeLastAttempt', () => {
  it('describes nothing when there is nothing to describe', () => {
    expect(describeLastAttempt(null, [])).toBeNull();
  });

  it('reads the stored attempt, mapping the view model’s count fields', () => {
    expect(describeLastAttempt(null, [stored()])).toEqual({
      score: 60,
      passed: 3,
      total: 5,
      submittedAt: Date.UTC(2026, 2, 9, 10, 30),
    });
  });

  // `getWorkspace` orders by `submittedAt` desc, so the newest is index 0.
  it('takes the newest stored attempt, not the oldest', () => {
    const rows = [stored({ id: 'new', score: 90 }), stored({ id: 'old', score: 10 })];

    expect(describeLastAttempt(null, rows)?.score).toBe(90);
  });

  /**
   * The ordering rule that matters. During the refresh window the stored list
   * still holds the *previous* attempt, so preferring it would show a
   * candidate the old score for the submission they just made.
   */
  it('prefers this session’s record over a stale stored row', () => {
    const result = describeLastAttempt(session, [stored({ score: 60 })]);

    expect(result?.score).toBe(100);
    expect(result?.passed).toBe(5);
  });

  // A session record has no stored timestamp yet. Null is carried through so
  // the dialog can omit the row rather than render an invented date.
  it('reports no timestamp for an attempt made in this session', () => {
    expect(describeLastAttempt(session, [])?.submittedAt).toBeNull();
    expect(describeLastAttempt(session, [stored()])?.submittedAt).toBeNull();
  });
});
