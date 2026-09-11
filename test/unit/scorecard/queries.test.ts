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
    revisions: [],
  };
}

type PanelFixture = string | { userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' };

function seatOf(fixture: PanelFixture): { userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' } {
  return typeof fixture === 'string' ? { userId: fixture, role: 'PANELIST' } : fixture;
}

interface StageFixture {
  id?: string;
  type?: string;
  status?: string;
  panel: PanelFixture[];
  feedback: FeedbackFixture[];
  blind?: boolean;
  assignment?: { interviewId: string; candidateId: string; status?: string } | null;
}

function stageRow(fixture: StageFixture, position: number) {
  return {
    id: fixture.id ?? 'stage1',
    name: 'System design',
    type: fixture.type ?? 'SYSTEM_DESIGN',
    status: fixture.status ?? 'COMPLETE',
    outcome: null,
    position,
    blindFeedback: fixture.blind ?? true,
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
    interviewers: fixture.panel.map(seatOf).map((seat) => ({
      userId: seat.userId,
      role: seat.role,
      user: { name: seat.userId, email: `${seat.userId}@example.com` },
    })),
    feedback: fixture.feedback.map(feedbackRow),
    assignment: fixture.assignment ?? null,
  };
}

function mockApplication(options: {
  panel?: PanelFixture[];
  feedback?: FeedbackFixture[];
  blind?: boolean;
  decision?: boolean;
  decisionSnapshot?: unknown;
  stages?: StageFixture[];
}) {
  const stages = options.stages ?? [
    {
      panel: options.panel ?? [],
      feedback: options.feedback ?? [],
      ...(options.blind === undefined ? {} : { blind: options.blind }),
    },
  ];
  h.db.application.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['stages'] === undefined) return Promise.resolve({ id: 'app1' });
    return Promise.resolve({
      id: 'app1',
      status: 'ACTIVE',
      candidate: { id: 'cand1', name: 'Ada', email: 'ada@example.com' },
      jobRole: { title: 'Backend L4' },
      owner: { name: 'Rita' },
      stages: stages.map(stageRow),
      decision: options.decision
        ? {
            outcome: 'HIRE',
            rationale: 'Because of the evidence above.',
            decidedAt: new Date('2026-01-06T00:00:00Z'),
            snapshot: options.decisionSnapshot ?? {},
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

  /**
   * One seat used to buy the whole process. `getPanelSeat` 404s an interviewer
   * on a round they do not sit on, so an interviewer shadowing a thirty-minute
   * screen was refused round four's stage page and handed the entire debrief —
   * every other round's prose, the aggregate, the decision and its rationale —
   * from this one. The two read paths over the same rows have to agree, and
   * the documented rule is that an interviewer sees the candidates they sit
   * on, not every word written about them.
   */
  it('returns null to an interviewer even with a seat on the application', async () => {
    mockApplication({ panel: ['viewer'], feedback: [] });
    h.db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat1' });

    expect(await getApplicationScorecard(user('INTERVIEWER'), 'app1')).toBeNull();
    expect(h.db.application.findUnique).not.toHaveBeenCalled();
  });

  it.each(['RECRUITER' as const, 'HIRING_MANAGER' as const, 'ADMIN' as const])(
    'lets a %s who may read every application open it',
    async (role) => {
      mockApplication({ panel: ['other'], feedback: [] });

      expect(await getApplicationScorecard(user(role), 'app1')).not.toBeNull();
    },
  );

  it('returns null for an application that does not exist', async () => {
    h.db.application.findUnique.mockResolvedValue(null);

    expect(await getApplicationScorecard(user('ADMIN'), 'nope')).toBeNull();
  });
});

/**
 * The panellist in these is an admin, because since the gate above only a role
 * with `VIEW_ALL_APPLICATIONS` can open the debrief at all — and rank does not
 * make anchoring less likely, so an admin who sat the round is blinded exactly
 * like anyone else who did.
 */
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

    const view = await getApplicationScorecard(user('ADMIN'), 'app1');
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

    const view = await getApplicationScorecard(user('ADMIN'), 'app1');
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

/** A shadow is an observer, on the debrief exactly as on the board. */
describe('getApplicationScorecard — the panel denominator', () => {
  it('neither expects nor counts a shadow’s scorecard', async () => {
    mockApplication({
      blind: false,
      panel: ['one', 'two', { userId: 'learner', role: 'SHADOW' }],
      feedback: [
        { authorId: 'one', status: 'SUBMITTED', recommendation: 'HIRE', score: 3 },
        { authorId: 'two', status: 'SUBMITTED', recommendation: 'HIRE', score: 3 },
        { authorId: 'learner', status: 'SUBMITTED', recommendation: 'STRONG_HIRE', score: 4 },
      ],
    });

    const view = await getApplicationScorecard(user('HIRING_MANAGER'), 'app1');
    const signal = view?.signal.stages[0];

    expect(signal?.panelSize).toBe(2);
    expect(signal?.submittedCount).toBe(2);
    expect(signal?.outstandingCount).toBe(0);
    // The fraction and the distribution are counted over the same seats, so
    // "3 of 2 scorecards in" is not expressible however keen the shadow is.
    expect(signal?.distribution.total).toBe(2);
    expect(signal?.partial).toBe(false);
    // Their scorecard is still readable — they were in the room.
    expect(view?.stages[0]?.scorecards.map((card) => card.authorId)).toContain('learner');
  });
});

describe('getApplicationScorecard — the derived stage status', () => {
  it('shows a submitted assessment as awaiting feedback, whatever the row says', async () => {
    mockApplication({
      stages: [
        {
          type: 'CODING_ASSESSMENT',
          status: 'PENDING',
          panel: ['one'],
          feedback: [],
          assignment: { interviewId: 'int1', candidateId: 'cand1', status: 'COMPLETED' },
        },
      ],
    });
    h.db.submission.findMany.mockResolvedValue([]);

    const view = await getApplicationScorecard(user('RECRUITER'), 'app1');

    expect(view?.stages[0]?.status).toBe('AWAITING_FEEDBACK');
  });
});

describe('getApplicationScorecard — the automated results', () => {
  it('reads every coding round in one query rather than one each', async () => {
    mockApplication({
      stages: [
        {
          id: 'coding1',
          type: 'CODING_ASSESSMENT',
          panel: ['one'],
          feedback: [],
          assignment: { interviewId: 'int1', candidateId: 'cand1' },
        },
        {
          id: 'coding2',
          type: 'CODING_ASSESSMENT',
          panel: ['one'],
          feedback: [],
          assignment: { interviewId: 'int2', candidateId: 'cand1' },
        },
        { id: 'talk', panel: ['one'], feedback: [] },
      ],
    });
    h.db.submission.findMany.mockResolvedValue([
      {
        id: 'sub1',
        interviewId: 'int1',
        candidateId: 'cand1',
        language: 'PYTHON',
        score: 80,
        passedCount: 4,
        totalCount: 5,
        submittedAt: new Date('2026-01-01T00:00:00Z'),
        results: {},
        question: { title: 'Two sum' },
      },
      {
        id: 'sub2',
        interviewId: 'int2',
        candidateId: 'cand1',
        language: 'PYTHON',
        score: 40,
        passedCount: 2,
        totalCount: 5,
        submittedAt: new Date('2026-01-02T00:00:00Z'),
        results: {},
        question: { title: 'Group by' },
      },
    ]);

    const view = await getApplicationScorecard(user('RECRUITER'), 'app1');

    expect(h.db.submission.findMany).toHaveBeenCalledTimes(1);
    expect(view?.stages[0]?.automated.map((run) => run.submissionId)).toEqual(['sub1']);
    expect(view?.stages[1]?.automated.map((run) => run.submissionId)).toEqual(['sub2']);
    // A round that is not an assessment has no runs, and no query of its own.
    expect(view?.stages[2]?.automated).toEqual([]);
  });

  it('does not query at all when no round is an assessment', async () => {
    mockApplication({ panel: ['one'], feedback: [] });

    await getApplicationScorecard(user('RECRUITER'), 'app1');

    expect(h.db.submission.findMany).not.toHaveBeenCalled();
  });
});

/**
 * `Decision.snapshot` was written on every decision and read by nothing, so
 * the column's promise — what the decider saw, not what the data says today —
 * was not kept by any page.
 */
describe('getApplicationScorecard — the decision snapshot', () => {
  it('returns the counts and distribution as they stood when the call was made', async () => {
    mockApplication({
      panel: ['one'],
      feedback: [],
      decision: true,
      decisionSnapshot: {
        capturedAt: '2026-01-06T00:00:00.000Z',
        signal: {
          panelSize: 3,
          submittedCount: 2,
          outstandingCount: 1,
          partial: true,
          distribution: {
            total: 2,
            buckets: [
              { recommendation: 'HIRE', count: 2 },
              { recommendation: 'NO', count: 0 },
            ],
          },
        },
      },
    });

    const snapshot = (await getApplicationScorecard(user('ADMIN'), 'app1'))?.decision?.snapshot;

    expect(snapshot?.capturedAt).toEqual(new Date('2026-01-06T00:00:00.000Z'));
    expect(snapshot?.panelSize).toBe(3);
    expect(snapshot?.submittedCount).toBe(2);
    expect(snapshot?.outstandingCount).toBe(1);
    expect(snapshot?.partial).toBe(true);
    expect(snapshot?.distribution.total).toBe(2);
  });

  it('is null rather than today’s numbers when the column cannot be read', async () => {
    mockApplication({ panel: ['one'], feedback: [], decision: true, decisionSnapshot: {} });

    const decision = (await getApplicationScorecard(user('ADMIN'), 'app1'))?.decision;

    expect(decision?.outcome).toBe('HIRE');
    expect(decision?.snapshot).toBeNull();
  });
});
