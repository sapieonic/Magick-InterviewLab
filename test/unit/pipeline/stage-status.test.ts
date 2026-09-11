import { describe, expect, it } from 'vitest';

import type { AssignmentStatus, StageStatus } from '@/generated/prisma/enums';
import {
  canSetCodingStageStatusByHand,
  canTransitionStageStatus,
  countScorecards,
  deriveCodingStageStatus,
  isManualStatusAllowedOnCodingStage,
  isStageResolved,
  STAGE_TRANSITIONS,
  stageTransitionError,
} from '@/features/pipeline/stage-status';

/**
 * The lifecycle, checked exhaustively.
 *
 * The expected matrix below is written out by hand rather than derived from
 * `STAGE_TRANSITIONS`, which is the entire point: a test that reads the table
 * it is testing only proves the table equals itself. Every one of the 36
 * ordered pairs is asserted, so widening the lifecycle by accident — the kind
 * of edit that quietly makes "complete" reachable from anywhere — fails here.
 */

const ALL: StageStatus[] = [
  'PENDING',
  'SCHEDULED',
  'IN_PROGRESS',
  'AWAITING_FEEDBACK',
  'COMPLETE',
  'SKIPPED',
];

const EXPECTED: Record<StageStatus, StageStatus[]> = {
  PENDING: ['SCHEDULED', 'IN_PROGRESS', 'SKIPPED'],
  SCHEDULED: ['PENDING', 'IN_PROGRESS', 'SKIPPED'],
  IN_PROGRESS: ['AWAITING_FEEDBACK', 'COMPLETE', 'SKIPPED'],
  AWAITING_FEEDBACK: ['COMPLETE', 'IN_PROGRESS', 'SKIPPED'],
  COMPLETE: ['AWAITING_FEEDBACK'],
  SKIPPED: ['PENDING'],
};

describe('stage status transitions', () => {
  it('covers every status in the table', () => {
    expect(Object.keys(STAGE_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });

  for (const from of ALL) {
    for (const to of ALL) {
      const allowed = from === to || EXPECTED[from].includes(to);
      it(`${from} → ${to} is ${allowed ? 'allowed' : 'refused'}`, () => {
        expect(canTransitionStageStatus(from, to)).toBe(allowed);
      });
    }
  }

  it('treats a no-op as legal so a double submit is not an error', () => {
    for (const status of ALL) expect(canTransitionStageStatus(status, status)).toBe(true);
  });

  it('makes COMPLETE terminal but for the explicit reopen', () => {
    for (const to of ALL) {
      if (to === 'COMPLETE' || to === 'AWAITING_FEEDBACK') continue;
      expect(canTransitionStageStatus('COMPLETE', to)).toBe(false);
    }
    expect(canTransitionStageStatus('COMPLETE', 'AWAITING_FEEDBACK')).toBe(true);
  });

  it('never lets a completed round be retconned into a skipped one', () => {
    expect(canTransitionStageStatus('COMPLETE', 'SKIPPED')).toBe(false);
  });

  it('names both ends and the way out in the refusal message', () => {
    const message = stageTransitionError('COMPLETE', 'PENDING');
    expect(message).toContain('complete');
    expect(message).toContain('pending');
    expect(message).toContain('Awaiting feedback');
  });
});

describe('isStageResolved', () => {
  it('counts only the two statuses that end a round', () => {
    expect(isStageResolved('COMPLETE')).toBe(true);
    expect(isStageResolved('SKIPPED')).toBe(true);
    for (const status of ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'AWAITING_FEEDBACK'] as const) {
      expect(isStageResolved(status)).toBe(false);
    }
  });
});

/**
 * The two-writer problem, pinned. The assignment is what the candidate
 * actually did; the stored status is what a human last said. These cases are
 * the contract the read models and `setStageStatusAction` both rely on.
 */
describe('deriveCodingStageStatus', () => {
  const cases: Array<[StageStatus, AssignmentStatus | null, StageStatus]> = [
    ['PENDING', 'ASSIGNED', 'PENDING'],
    ['SCHEDULED', 'ASSIGNED', 'SCHEDULED'],
    ['IN_PROGRESS', 'ASSIGNED', 'PENDING'],
    ['PENDING', 'IN_PROGRESS', 'IN_PROGRESS'],
    ['SCHEDULED', 'IN_PROGRESS', 'IN_PROGRESS'],
    ['PENDING', 'COMPLETED', 'AWAITING_FEEDBACK'],
    ['SCHEDULED', 'COMPLETED', 'AWAITING_FEEDBACK'],
    ['AWAITING_FEEDBACK', 'COMPLETED', 'AWAITING_FEEDBACK'],
  ];

  for (const [stored, assignment, expected] of cases) {
    it(`${stored} + assignment ${assignment} reads as ${expected}`, () => {
      expect(deriveCodingStageStatus(stored, assignment)).toBe(expected);
    });
  }

  it('lets the human judgements outrank the assignment', () => {
    // A debriefed round stays debriefed even if the candidate reopens the
    // workspace, and a dropped round stays dropped.
    expect(deriveCodingStageStatus('COMPLETE', 'IN_PROGRESS')).toBe('COMPLETE');
    expect(deriveCodingStageStatus('COMPLETE', 'COMPLETED')).toBe('COMPLETE');
    expect(deriveCodingStageStatus('SKIPPED', 'COMPLETED')).toBe('SKIPPED');
  });

  it('falls back to the stored status when no assessment is attached', () => {
    expect(deriveCodingStageStatus('SCHEDULED', null)).toBe('SCHEDULED');
    expect(deriveCodingStageStatus('IN_PROGRESS', null)).toBe('IN_PROGRESS');
  });

  it('never reports a submitted assessment as complete on its own', () => {
    // A machine score is not a verdict — somebody still has to read the code.
    expect(deriveCodingStageStatus('PENDING', 'COMPLETED')).not.toBe('COMPLETE');
  });
});

describe('manual statuses on a coding round', () => {
  it('allows only the two the assessment cannot know about', () => {
    expect(isManualStatusAllowedOnCodingStage('COMPLETE')).toBe(true);
    expect(isManualStatusAllowedOnCodingStage('SKIPPED')).toBe(true);
    for (const status of ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'AWAITING_FEEDBACK'] as const) {
      expect(isManualStatusAllowedOnCodingStage(status)).toBe(false);
    }
  });
});

/**
 * The two tables composed, which is the only way either is ever asked in
 * anger — and the gap the isolated suites above could not see. Each table was
 * correct; applying one to the target and the other to the pair made a
 * completed coding round permanent, because every exit the lifecycle allows
 * from a terminal state is a status the coding guard refuses.
 */
describe('a coding round, lifecycle and manual guard together', () => {
  it('lets a completed round be reopened', () => {
    // The pair the two tables used to cancel out.
    expect(canTransitionStageStatus('COMPLETE', 'AWAITING_FEEDBACK')).toBe(true);
    expect(isManualStatusAllowedOnCodingStage('AWAITING_FEEDBACK')).toBe(false);
    expect(canSetCodingStageStatusByHand('COMPLETE', 'AWAITING_FEEDBACK')).toBe(true);
  });

  it('lets a skipped round be un-skipped', () => {
    expect(canSetCodingStageStatusByHand('SKIPPED', 'PENDING')).toBe(true);
  });

  it('leaves every terminal state with a way out', () => {
    for (const from of ['COMPLETE', 'SKIPPED'] as const) {
      const exits = STAGE_TRANSITIONS[from].filter((to) => canSetCodingStageStatusByHand(from, to));
      expect(exits).toEqual([...STAGE_TRANSITIONS[from]]);
    }
  });

  it('still refuses progress a person types over the assessment', () => {
    expect(canSetCodingStageStatusByHand('PENDING', 'SCHEDULED')).toBe(false);
    expect(canSetCodingStageStatusByHand('PENDING', 'IN_PROGRESS')).toBe(false);
    expect(canSetCodingStageStatusByHand('IN_PROGRESS', 'AWAITING_FEEDBACK')).toBe(false);
    expect(canSetCodingStageStatusByHand('SCHEDULED', 'IN_PROGRESS')).toBe(false);
  });

  it('still allows the two judgements the assessment cannot make', () => {
    expect(canSetCodingStageStatusByHand('AWAITING_FEEDBACK', 'COMPLETE')).toBe(true);
    expect(canSetCodingStageStatusByHand('PENDING', 'SKIPPED')).toBe(true);
  });

  it('never widens the lifecycle itself', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (canSetCodingStageStatusByHand(from, to)) {
          expect(canTransitionStageStatus(from, to)).toBe(true);
        }
      }
    }
    // Including the one the lifecycle refuses outright: a round that was sat
    // cannot be retconned into one that never happened, coding or not.
    expect(canSetCodingStageStatusByHand('COMPLETE', 'SKIPPED')).toBe(false);
  });
});

/**
 * The panel denominator, in the one place both halves of it are decided.
 * `pipeline/queries.ts` is the caller; the rule lives here so the feedback and
 * scorecard layers can hold the same one rather than re-deriving it.
 */
describe('countScorecards', () => {
  const lead = { userId: 'u1', role: 'LEAD' as const };
  const panelist = { userId: 'u2', role: 'PANELIST' as const };
  const shadow = { userId: 'u3', role: 'SHADOW' as const };

  it('expects one scorecard per non-shadow seat', () => {
    const counts = countScorecards([lead, panelist, shadow], [], 'AWAITING_FEEDBACK');
    expect(counts.expected).toBe(2);
    expect(counts.outstanding).toBe(2);
  });

  it('does not count a shadow\u2019s submission in the numerator either', () => {
    const counts = countScorecards(
      [lead, shadow],
      [
        { authorId: 'u1', status: 'SUBMITTED' },
        { authorId: 'u3', status: 'SUBMITTED' },
      ],
      'AWAITING_FEEDBACK',
    );

    // Not 2/1. Both halves of the fraction apply the same rule about who is
    // part of the panel's verdict.
    expect(counts).toEqual({ expected: 1, submitted: 1, outstanding: 0 });
  });

  it('ignores a scorecard from someone with no seat at all', () => {
    const counts = countScorecards(
      [lead],
      [{ authorId: 'stranger', status: 'SUBMITTED' }],
      'AWAITING_FEEDBACK',
    );
    expect(counts).toEqual({ expected: 1, submitted: 0, outstanding: 1 });
  });

  it('does not count a draft', () => {
    const counts = countScorecards([lead], [{ authorId: 'u1', status: 'DRAFT' }], 'COMPLETE');
    expect(counts.submitted).toBe(0);
    expect(counts.outstanding).toBe(1);
  });

  it('owes nothing until the round has run, and nothing once it is skipped', () => {
    for (const status of ['PENDING', 'SCHEDULED', 'SKIPPED'] as const) {
      expect(countScorecards([lead, panelist], [], status).outstanding).toBe(0);
    }
    for (const status of ['IN_PROGRESS', 'AWAITING_FEEDBACK', 'COMPLETE'] as const) {
      expect(countScorecards([lead, panelist], [], status).outstanding).toBe(2);
    }
  });
});
