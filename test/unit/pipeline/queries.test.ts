import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { summariseStages } from '@/features/pipeline/queries';
import type { InterviewerRole, StageStatus, StageType } from '@/generated/prisma/enums';

/**
 * The arithmetic the board and the header both read.
 *
 * Worth its own suite because every number on the recruiter's screen comes
 * from it: which round the candidate is on, how many scorecards are late, and
 * how long nothing has happened.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-03-10T12:00:00Z');

function stage(overrides: {
  id: string;
  position: number;
  status: StageStatus;
  type?: StageType;
  panel?: InterviewerRole[];
  submitted?: number;
  drafts?: number;
  updatedDaysAgo?: number;
  assignment?: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | null;
}) {
  const submitted = overrides.submitted ?? 0;
  const drafts = overrides.drafts ?? 0;
  return {
    id: overrides.id,
    name: `Round ${overrides.position}`,
    type: overrides.type ?? ('LIVE_CODING' as StageType),
    position: overrides.position,
    status: overrides.status,
    outcome: null,
    scheduledAt: null,
    updatedAt: new Date(NOW.getTime() - (overrides.updatedDaysAgo ?? 0) * DAY_MS),
    assignment: overrides.assignment ? { status: overrides.assignment } : null,
    interviewers: (overrides.panel ?? []).map((role) => ({ role })),
    feedback: [
      ...Array.from({ length: submitted }, () => ({ status: 'SUBMITTED' as const })),
      ...Array.from({ length: drafts }, () => ({ status: 'DRAFT' as const })),
    ],
  };
}

describe('summariseStages', () => {
  it('picks the first unresolved round as the current one', () => {
    const progress = summariseStages(
      [
        stage({ id: 'a', position: 0, status: 'COMPLETE' }),
        stage({ id: 'b', position: 1, status: 'SKIPPED' }),
        stage({ id: 'c', position: 2, status: 'SCHEDULED' }),
        stage({ id: 'd', position: 3, status: 'PENDING' }),
      ],
      NOW,
    );

    expect(progress.currentStage?.id).toBe('c');
    expect(progress.nextStage?.id).toBe('d');
  });

  it('reports nothing in flight once every round is resolved', () => {
    const progress = summariseStages(
      [
        stage({ id: 'a', position: 0, status: 'COMPLETE' }),
        stage({ id: 'b', position: 1, status: 'COMPLETE' }),
      ],
      NOW,
    );

    expect(progress.currentStage).toBeNull();
    expect(progress.nextStage).toBeNull();
    expect(progress.daysInStage).toBeNull();
  });

  it('excludes skipped rounds from the total but not completed ones', () => {
    const progress = summariseStages(
      [
        stage({ id: 'a', position: 0, status: 'COMPLETE' }),
        stage({ id: 'b', position: 1, status: 'SKIPPED' }),
        stage({ id: 'c', position: 2, status: 'PENDING' }),
      ],
      NOW,
    );

    expect(progress.stagesComplete).toBe(1);
    expect(progress.stagesTotal).toBe(2);
  });

  it('counts a scorecard as outstanding only once the round has run', () => {
    const pending = summariseStages(
      [stage({ id: 'a', position: 0, status: 'PENDING', panel: ['LEAD', 'PANELIST'] })],
      NOW,
    );
    expect(pending.outstandingScorecards).toBe(0);

    const waiting = summariseStages(
      [
        stage({
          id: 'a',
          position: 0,
          status: 'AWAITING_FEEDBACK',
          panel: ['LEAD', 'PANELIST'],
          submitted: 1,
        }),
      ],
      NOW,
    );
    expect(waiting.outstandingScorecards).toBe(1);
  });

  it('does not count a shadow as owing a scorecard', () => {
    const progress = summariseStages(
      [
        stage({
          id: 'a',
          position: 0,
          status: 'AWAITING_FEEDBACK',
          panel: ['LEAD', 'SHADOW'],
          submitted: 1,
        }),
      ],
      NOW,
    );

    expect(progress.stages[0]?.expectedScorecards).toBe(1);
    expect(progress.outstandingScorecards).toBe(0);
  });

  it('does not count a draft as submitted', () => {
    const progress = summariseStages(
      [stage({ id: 'a', position: 0, status: 'AWAITING_FEEDBACK', panel: ['LEAD'], drafts: 1 })],
      NOW,
    );

    expect(progress.stages[0]?.submittedScorecards).toBe(0);
    expect(progress.outstandingScorecards).toBe(1);
  });

  it('lets the assignment overtake a coding round that a human never moved', () => {
    const progress = summariseStages(
      [
        stage({
          id: 'a',
          position: 0,
          type: 'CODING_ASSESSMENT',
          status: 'SCHEDULED',
          assignment: 'COMPLETED',
        }),
      ],
      NOW,
    );

    expect(progress.stages[0]?.storedStatus).toBe('SCHEDULED');
    expect(progress.stages[0]?.status).toBe('AWAITING_FEEDBACK');
    expect(progress.currentStage?.id).toBe('a');
  });

  it('measures days in stage from the current round, not the application', () => {
    const progress = summariseStages(
      [
        stage({ id: 'a', position: 0, status: 'COMPLETE', updatedDaysAgo: 30 }),
        stage({ id: 'b', position: 1, status: 'AWAITING_FEEDBACK', updatedDaysAgo: 9 }),
      ],
      NOW,
    );

    expect(progress.daysInStage).toBe(9);
  });

  it('sorts by position rather than trusting the caller', () => {
    const progress = summariseStages(
      [
        stage({ id: 'c', position: 2, status: 'PENDING' }),
        stage({ id: 'a', position: 0, status: 'PENDING' }),
        stage({ id: 'b', position: 1, status: 'PENDING' }),
      ],
      NOW,
    );

    expect(progress.stages.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(progress.currentStage?.id).toBe('a');
  });
});
