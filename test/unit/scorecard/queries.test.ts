import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionUser } from '@/features/auth/session';
import type { Role } from '@/generated/prisma/enums';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { getApplicationScorecard } from '@/features/scorecard/queries';

/**
 * The debrief has to apply the blind rule per stage, and — the part that is
 * easy to miss — has to apply it to the *numbers* as well as to the prose. An
 * average anchors a panellist just as effectively as an opinion does, so a
 * withheld scorecard must be absent from the aggregate too.
 */

function user(role: Role, id = 'viewer'): SessionUser {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    role,
    isActive: true,
    mustChangePassword: false,
  };
}

interface FeedbackFixture {
  authorId: string;
  status: 'DRAFT' | 'SUBMITTED';
  recommendation?: 'HIRE' | 'NO' | 'STRONG_HIRE';
  score?: number;
}

function feedbackRow(fixture: FeedbackFixture) {
  return {
    id: `fb-${fixture.authorId}`,
    authorId: fixture.authorId,
    status: fixture.status,
    recommendation: fixture.recommendation ?? null,
    confidence: 'HIGH',
    summary: `summary from ${fixture.authorId}`,
    strengths: '',
    concerns: '',
    rubricVersionId: 'rv1',
    submittedAt: fixture.status === 'SUBMITTED' ? new Date('2026-01-02T00:00:00Z') : null,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    author: { name: fixture.authorId },
    scores: [{ criterionId: 'c1', score: fixture.score ?? 4, note: '' }],
    _count: { revisions: 0 },
  };
}

function mockApplication(options: {
  panel: string[];
  feedback: FeedbackFixture[];
  blind?: boolean;
  decision?: boolean;
}) {
  h.db.application.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['stages'] === undefined) return Promise.resolve({ id: 'app1' });
    return Promise.resolve({
      id: 'app1',
      status: 'ACTIVE',
      candidate: { id: 'cand1', name: 'Ada', email: 'ada@example.com' },
      jobRole: { title: 'Backend L4' },
      owner: { name: 'Rita' },
      stages: [
        {
          id: 'stage1',
          name: 'System design',
          type: 'SYSTEM_DESIGN',
          status: 'COMPLETE',
          outcome: null,
          position: 0,
          blindFeedback: options.blind ?? true,
          scheduledAt: null,
          completedAt: new Date('2026-01-01T00:00:00Z'),
          rubricVersion: {
            id: 'rv1',
            version: 1,
            rubric: { name: 'Engineering' },
            criteria: [
              { id: 'c1', name: 'Design', description: '', weight: 1, maxScore: 4, position: 0 },
            ],
          },
          interviewers: options.panel.map((userId) => ({
            userId,
            role: 'PANELIST',
            user: { name: userId, email: `${userId}@example.com` },
          })),
          feedback: options.feedback.map(feedbackRow),
          assignment: null,
        },
      ],
      decision: options.decision
        ? {
            outcome: 'HIRE',
            rationale: 'Because of the evidence above.',
            decidedAt: new Date('2026-01-06T00:00:00Z'),
            decidedBy: { name: 'Hana' },
          }
        : null,
    });
  });
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.db.auditEvent.findMany.mockResolvedValue([]);
});

describe('getApplicationScorecard — access', () => {
  it('returns null to a candidate without reading anything', async () => {
    mockApplication({ panel: [], feedback: [] });

    expect(await getApplicationScorecard(user('CANDIDATE', 'cand1'), 'app1')).toBeNull();
    expect(h.db.application.findUnique).not.toHaveBeenCalled();
  });

  it('returns null to an interviewer with no seat anywhere on the application', async () => {
    mockApplication({ panel: ['other'], feedback: [] });
    h.db.stageInterviewer.findFirst.mockResolvedValue(null);

    expect(await getApplicationScorecard(user('INTERVIEWER'), 'app1')).toBeNull();
  });

  it('returns null for an application that does not exist', async () => {
    h.db.application.findUnique.mockResolvedValue(null);

    expect(await getApplicationScorecard(user('ADMIN'), 'nope')).toBeNull();
  });
});

describe('getApplicationScorecard — the blind rule reaches the numbers', () => {
  it('withholds both the prose and the aggregate from a panellist who has not submitted', async () => {
    mockApplication({
      panel: ['viewer', 'other'],
      feedback: [
        { authorId: 'viewer', status: 'DRAFT' },
        { authorId: 'other', status: 'SUBMITTED', recommendation: 'STRONG_HIRE', score: 4 },
      ],
    });
    h.db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat1' });

    const view = await getApplicationScorecard(user('INTERVIEWER'), 'app1');
    const stage = view?.stages[0];
    const signal = view?.signal.stages[0];

    expect(stage?.scorecards).toEqual([]);
    expect(stage?.hidden.submitted).toBe(1);
    expect(stage?.hidden.reason).toBe('OWN_FEEDBACK_PENDING');
    expect(stage?.viewerHasDraft).toBe(true);
    expect(signal?.distribution.total).toBe(0);
    expect(signal?.partial).toBe(true);
    expect(signal?.criteria[0]?.mean).toBeNull();
    expect(JSON.stringify(view)).not.toContain('summary from other');
  });

  it('releases both once the panellist has submitted', async () => {
    mockApplication({
      panel: ['viewer', 'other'],
      feedback: [
        { authorId: 'viewer', status: 'SUBMITTED', recommendation: 'NO', score: 2 },
        { authorId: 'other', status: 'SUBMITTED', recommendation: 'STRONG_HIRE', score: 4 },
      ],
    });
    h.db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat1' });

    const view = await getApplicationScorecard(user('INTERVIEWER'), 'app1');
    const signal = view?.signal.stages[0];

    expect(view?.stages[0]?.scorecards).toHaveLength(2);
    expect(signal?.distribution.total).toBe(2);
    expect(signal?.partial).toBe(false);
    expect(signal?.criteria[0]?.mean).toBe(3);
    // A split across the hire line is the thing the debrief most needs told.
    expect(signal?.disagreement.straddlesHireLine).toBe(true);
  });

  it('shows a hiring manager the submitted scorecards and never a draft', async () => {
    mockApplication({
      panel: ['other', 'third'],
      feedback: [
        { authorId: 'other', status: 'SUBMITTED', recommendation: 'HIRE' },
        { authorId: 'third', status: 'DRAFT' },
      ],
    });

    const view = await getApplicationScorecard(user('HIRING_MANAGER'), 'app1');

    expect(view?.stages[0]?.scorecards.map((f) => f.authorId)).toEqual(['other']);
    expect(view?.stages[0]?.hidden.reason).toBeNull();
    expect(view?.signal.stages[0]?.outstandingCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('summary from third');
    expect(view?.viewer.canDecide).toBe(true);
  });

  it('does not offer the decision box to someone without DECIDE', async () => {
    mockApplication({ panel: ['other'], feedback: [] });

    const view = await getApplicationScorecard(user('RECRUITER'), 'app1');

    expect(view?.viewer.canDecide).toBe(false);
  });
});

describe('getApplicationScorecard — decision history', () => {
  it('reads the reversal out of the audit log, since the row holds only the current outcome', async () => {
    mockApplication({ panel: ['other'], feedback: [], decision: true });
    h.db.auditEvent.findMany.mockResolvedValue([
      {
        createdAt: new Date('2026-01-05T00:00:00Z'),
        metadata: { outcome: 'NO_HIRE' },
        actor: { name: 'Hana' },
      },
      {
        createdAt: new Date('2026-01-06T00:00:00Z'),
        metadata: { outcome: 'HIRE', previousOutcome: 'NO_HIRE' },
        actor: { name: 'Hana' },
      },
    ]);

    const view = await getApplicationScorecard(user('ADMIN'), 'app1');

    expect(view?.decision?.outcome).toBe('HIRE');
    expect(view?.decision?.history).toEqual([
      {
        at: new Date('2026-01-05T00:00:00Z'),
        actorName: 'Hana',
        outcome: 'NO_HIRE',
        previousOutcome: null,
      },
      {
        at: new Date('2026-01-06T00:00:00Z'),
        actorName: 'Hana',
        outcome: 'HIRE',
        previousOutcome: 'NO_HIRE',
      },
    ]);
  });

  it('tolerates audit metadata it does not recognise', async () => {
    mockApplication({ panel: ['other'], feedback: [], decision: true });
    h.db.auditEvent.findMany.mockResolvedValue([
      { createdAt: new Date('2026-01-05T00:00:00Z'), metadata: 'not an object', actor: null },
    ]);

    const view = await getApplicationScorecard(user('ADMIN'), 'app1');

    expect(view?.decision?.history[0]?.outcome).toBeNull();
  });

  it('does not query the log at all when nothing has been decided', async () => {
    mockApplication({ panel: ['other'], feedback: [] });

    const view = await getApplicationScorecard(user('ADMIN'), 'app1');

    expect(view?.decision).toBeNull();
    expect(h.db.auditEvent.findMany).not.toHaveBeenCalled();
  });
});
