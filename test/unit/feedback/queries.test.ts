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
import {
  getStageForFeedback,
  getSubmissionNotes,
  listMyFeedback,
  listOutstandingFeedback,
  resolveSubmissionScope,
} from '@/features/feedback/queries';

/**
 * The blind rule, exercised where it is actually enforced.
 *
 * These assertions are deliberately about the *returned data*, not about a
 * rendered page: the whole point of putting the rule in the query layer is
 * that a read model must never hand a caller rows it was not entitled to, so
 * "the component hides it" would not be a passing test.
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

interface RevisionFixture {
  id: string;
  at: string;
  reason?: string;
  snapshot?: unknown;
}

interface FeedbackFixture {
  id: string;
  authorId: string;
  status: 'DRAFT' | 'SUBMITTED';
  summary?: string;
  submittedAt?: string;
  revisions?: RevisionFixture[];
}

function feedbackRow(fixture: FeedbackFixture) {
  const revisions = fixture.revisions ?? [];
  return {
    id: fixture.id,
    authorId: fixture.authorId,
    status: fixture.status,
    recommendation: fixture.status === 'SUBMITTED' ? 'HIRE' : null,
    confidence: fixture.status === 'SUBMITTED' ? 'HIGH' : null,
    summary: fixture.summary ?? `summary from ${fixture.authorId}`,
    strengths: '',
    concerns: '',
    rubricVersionId: 'rv1',
    submittedAt:
      fixture.status === 'SUBMITTED'
        ? new Date(fixture.submittedAt ?? '2026-01-02T00:00:00Z')
        : null,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    author: { name: fixture.authorId },
    scores: [{ criterionId: 'c1', score: 3, note: '' }],
    _count: { revisions: revisions.length },
    revisions: revisions.map((revision) => ({
      id: revision.id,
      createdAt: new Date(revision.at),
      reason: revision.reason ?? '',
      snapshot:
        revision.snapshot === undefined
          ? {
              status: 'SUBMITTED',
              recommendation: 'LEAN_NO',
              confidence: 'LOW',
              summary: `the first draft from ${fixture.authorId}`,
              strengths: '',
              concerns: '',
              rubricVersionId: 'rv1',
              submittedAt: '2026-01-02T00:00:00.000Z',
              updatedAt: '2026-01-02T00:00:00.000Z',
              scores: [{ criterionId: 'c1', score: 1, note: '' }],
            }
          : revision.snapshot,
      editedBy: { name: fixture.authorId },
    })),
  };
}

type PanelFixture = string | { userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' };

function seatOf(fixture: PanelFixture): { userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' } {
  return typeof fixture === 'string' ? { userId: fixture, role: 'PANELIST' } : fixture;
}

/**
 * Two different `stage.findUnique` calls run on this path — the panel-seat
 * lookup in `access.ts` and the full read here — so the mock answers by the
 * shape of the select rather than by call order.
 */
function mockStage(options: {
  blind: boolean;
  panel: PanelFixture[];
  feedback: FeedbackFixture[];
  type?: 'CODING_ASSESSMENT' | 'BEHAVIORAL';
  assignment?: { interviewId: string; candidateId: string; status?: string } | null;
  status?: string;
}) {
  const rows = options.feedback.map(feedbackRow);
  const seats = options.panel.map(seatOf);
  h.db.stage.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['application'] === undefined) {
      return Promise.resolve({
        id: 'stage1',
        applicationId: 'app1',
        blindFeedback: options.blind,
        interviewers: seats.some((seat) => seat.userId === 'viewer') ? [{ id: 'seat-viewer' }] : [],
      });
    }
    return Promise.resolve({
      id: 'stage1',
      name: 'System design',
      type: options.type ?? 'BEHAVIORAL',
      status: options.status ?? 'AWAITING_FEEDBACK',
      blindFeedback: options.blind,
      scheduledAt: null,
      completedAt: new Date('2026-01-01T00:00:00Z'),
      application: {
        id: 'app1',
        candidate: { id: 'cand1', name: 'Ada', email: 'ada@example.com' },
        jobRole: { title: 'Backend L4' },
      },
      rubricVersion: {
        id: 'rv1',
        version: 2,
        rubric: { name: 'Engineering' },
        criteria: [
          {
            id: 'c1',
            name: 'Design',
            description: '',
            weight: 1,
            maxScore: 4,
            position: 0,
          },
        ],
      },
      interviewers: seats.map((seat) => ({
        userId: seat.userId,
        role: seat.role,
        user: { name: seat.userId, email: `${seat.userId}@example.com` },
      })),
      feedback: rows,
      assignment: options.assignment ?? null,
    });
  });
}

beforeEach(() => {
  resetPrismaMock(h.db);
});

describe('getStageForFeedback — the blind rule', () => {
  it('withholds a colleague’s submitted scorecard from a panellist who has not submitted', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other'],
      feedback: [
        { id: 'f-viewer', authorId: 'viewer', status: 'DRAFT' },
        { id: 'f-other', authorId: 'other', status: 'SUBMITTED' },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.others).toEqual([]);
    expect(view?.hidden.submitted).toBe(1);
    expect(view?.hidden.reason).toBe('OWN_FEEDBACK_PENDING');
    // The count is the whole point: the page can say how many without saying what.
    expect(JSON.stringify(view)).not.toContain('summary from other');
  });

  it('releases them the moment the panellist’s own scorecard is submitted', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other'],
      feedback: [
        { id: 'f-viewer', authorId: 'viewer', status: 'SUBMITTED' },
        { id: 'f-other', authorId: 'other', status: 'SUBMITTED' },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.others.map((f) => f.id)).toEqual(['f-other']);
    expect(view?.hidden.submitted).toBe(0);
    expect(view?.hidden.reason).toBeNull();
    expect(view?.viewer.hasSubmitted).toBe(true);
  });

  /**
   * A recruiter or hiring manager is not writing a scorecard, so there is
   * nothing for them to anchor — blinding them would buy no independence and
   * would push the debrief into a meeting nobody can audit.
   */
  it('does not blind a non-panellist who may read every application', async () => {
    mockStage({
      blind: true,
      panel: ['other'],
      feedback: [{ id: 'f-other', authorId: 'other', status: 'SUBMITTED' }],
    });

    const view = await getStageForFeedback(user('RECRUITER'), 'stage1');

    expect(view?.others.map((f) => f.id)).toEqual(['f-other']);
    expect(view?.hidden.reason).toBeNull();
    expect(view?.viewer.isPanelist).toBe(false);
    expect(view?.viewer.canWrite).toBe(false);
  });

  /** Rank does not make anchoring less likely. */
  it('blinds an admin who is on the panel just like anyone else', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other'],
      feedback: [{ id: 'f-other', authorId: 'other', status: 'SUBMITTED' }],
    });

    const view = await getStageForFeedback(user('ADMIN'), 'stage1');

    expect(view?.others).toEqual([]);
    expect(view?.hidden.reason).toBe('OWN_FEEDBACK_PENDING');
  });

  it('shows the panel to each other when the stage is not running blind', async () => {
    mockStage({
      blind: false,
      panel: ['viewer', 'other'],
      feedback: [{ id: 'f-other', authorId: 'other', status: 'SUBMITTED' }],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.others.map((f) => f.id)).toEqual(['f-other']);
    expect(view?.hidden.reason).toBeNull();
  });

  it.each([
    ['ADMIN' as const, ['viewer', 'other']],
    ['RECRUITER' as const, ['other']],
    ['HIRING_MANAGER' as const, ['other']],
    ['INTERVIEWER' as const, ['viewer', 'other']],
  ])("never shows another author's draft to a %s", async (role, panel) => {
    mockStage({
      blind: false,
      panel,
      feedback: [
        { id: 'f-viewer', authorId: 'viewer', status: 'SUBMITTED' },
        { id: 'f-other', authorId: 'other', status: 'DRAFT', summary: 'half an opinion' },
      ],
    });

    const view = await getStageForFeedback(user(role), 'stage1');

    expect(view?.others).toEqual([]);
    expect(view?.hidden.drafts).toBe(1);
    expect(JSON.stringify(view)).not.toContain('half an opinion');
  });

  it('always returns the viewer their own draft', async () => {
    mockStage({
      blind: true,
      panel: ['viewer'],
      feedback: [{ id: 'f-viewer', authorId: 'viewer', status: 'DRAFT', summary: 'mine' }],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.own?.id).toBe('f-viewer');
    expect(view?.own?.summary).toBe('mine');
  });

  it('counts panel progress without disclosing content', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other', 'third'],
      feedback: [
        { id: 'f-other', authorId: 'other', status: 'SUBMITTED' },
        { id: 'f-third', authorId: 'third', status: 'DRAFT' },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.progress).toEqual({ panelSize: 3, submittedCount: 1, outstandingCount: 2 });
    expect(view?.panel.find((p) => p.userId === 'other')?.hasSubmitted).toBe(true);
    expect(view?.panel.find((p) => p.userId === 'third')?.hasSubmitted).toBe(false);
  });
});

describe('getStageForFeedback — access', () => {
  it('returns null for a candidate and never reads the stage', async () => {
    mockStage({ blind: true, panel: [], feedback: [] });

    expect(await getStageForFeedback(user('CANDIDATE', 'cand1'), 'stage1')).toBeNull();
    expect(h.db.stage.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an interviewer with no seat on the stage', async () => {
    mockStage({ blind: true, panel: ['other'], feedback: [] });

    expect(await getStageForFeedback(user('INTERVIEWER'), 'stage1')).toBeNull();
  });

  it('returns null for a stage that does not exist', async () => {
    h.db.stage.findUnique.mockResolvedValue(null);

    expect(await getStageForFeedback(user('ADMIN'), 'missing')).toBeNull();
  });

  it('loads the candidate’s code for a coding round and nothing for any other', async () => {
    h.db.submission.findMany.mockResolvedValue([
      {
        id: 'sub1',
        language: 'PYTHON',
        sourceCode: 'print(1)',
        score: 80,
        passedCount: 4,
        totalCount: 5,
        submittedAt: new Date('2026-01-01T00:00:00Z'),
        results: {},
        question: { title: 'Two sum' },
      },
    ]);
    mockStage({
      blind: true,
      panel: ['viewer'],
      feedback: [],
      type: 'CODING_ASSESSMENT',
      assignment: { interviewId: 'int1', candidateId: 'cand1' },
    });

    const coding = await getStageForFeedback(user('INTERVIEWER'), 'stage1');
    expect(coding?.submissions.map((s) => s.id)).toEqual(['sub1']);

    resetPrismaMock(h.db);
    mockStage({ blind: true, panel: ['viewer'], feedback: [], type: 'BEHAVIORAL' });
    const behavioural = await getStageForFeedback(user('INTERVIEWER'), 'stage1');
    expect(behavioural?.submissions).toEqual([]);
    expect(h.db.submission.findMany).not.toHaveBeenCalled();
  });
});

describe('listMyFeedback', () => {
  const now = new Date('2026-01-20T00:00:00Z');

  function seat(options: {
    id: string;
    completedAt: string | null;
    status?: 'DRAFT' | 'SUBMITTED';
    stageStatus?: string;
    type?: string;
    assignment?: { status: string } | null;
  }) {
    return {
      stage: {
        id: options.id,
        name: options.id,
        type: options.type ?? 'BEHAVIORAL',
        status: options.stageStatus ?? 'AWAITING_FEEDBACK',
        scheduledAt: null,
        completedAt: options.completedAt ? new Date(options.completedAt) : null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        assignment: options.assignment ?? null,
        application: {
          id: 'app1',
          candidate: { name: 'Ada' },
          jobRole: { title: 'Backend L4' },
        },
        feedback: options.status
          ? [{ status: options.status, submittedAt: new Date('2026-01-15T00:00:00Z') }]
          : [],
      },
    };
  }

  it('returns nothing to a candidate and never queries', async () => {
    expect(await listMyFeedback(user('CANDIDATE', 'cand1'), now)).toEqual([]);
    expect(h.db.stageInterviewer.findMany).not.toHaveBeenCalled();
  });

  it('puts outstanding rounds first, oldest first, with submitted ones last', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([
      seat({ id: 'recent', completedAt: '2026-01-18T00:00:00Z' }),
      seat({ id: 'done', completedAt: '2026-01-02T00:00:00Z', status: 'SUBMITTED' }),
      seat({ id: 'old', completedAt: '2026-01-05T00:00:00Z', status: 'DRAFT' }),
    ]);

    const rows = await listMyFeedback(user('INTERVIEWER'), now);

    expect(rows.map((r) => r.stageId)).toEqual(['old', 'recent', 'done']);
    expect(rows[0]?.ageDays).toBe(15);
    expect(rows[1]?.ageDays).toBe(2);
  });

  it('ages a round that was never completed from when it was scheduled or created', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([seat({ id: 'never', completedAt: null })]);

    const rows = await listMyFeedback(user('INTERVIEWER'), now);

    expect(rows[0]?.ageDays).toBe(19);
  });
});

describe('listOutstandingFeedback', () => {
  const now = new Date('2026-01-10T00:00:00Z');

  function stage(
    feedback: Array<{ authorId: string; status: 'DRAFT' | 'SUBMITTED' }>,
    options: { panel?: PanelFixture[]; stageStatus?: string } = {},
  ) {
    const seats = (options.panel ?? ['a', 'b']).map(seatOf);
    return {
      id: 'stage1',
      name: 'Round',
      type: 'BEHAVIORAL',
      status: options.stageStatus ?? 'AWAITING_FEEDBACK',
      scheduledAt: null,
      completedAt: new Date('2026-01-05T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      assignment: null,
      application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
      interviewers: seats.map((seatRow) => ({
        userId: seatRow.userId,
        role: seatRow.role,
        user: {
          name: seatRow.userId === 'a' ? 'Alice' : seatRow.userId === 'b' ? 'Bob' : seatRow.userId,
          email: `${seatRow.userId}@example.com`,
        },
      })),
      feedback,
    };
  }

  it.each(['CANDIDATE' as const, 'INTERVIEWER' as const])(
    'returns nothing to a %s and never queries',
    async (role) => {
      expect(await listOutstandingFeedback(user(role), now)).toEqual([]);
      expect(h.db.stage.findMany).not.toHaveBeenCalled();
    },
  );

  it('reports who owes what, marking a started draft as still owed', async () => {
    h.db.stage.findMany.mockResolvedValue([
      stage([
        { authorId: 'a', status: 'SUBMITTED' },
        { authorId: 'b', status: 'DRAFT' },
      ]),
    ]);

    const rows = await listOutstandingFeedback(user('RECRUITER'), now);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.owed).toEqual([
      { userId: 'b', name: 'Bob', email: 'b@example.com', status: 'DRAFT' },
    ]);
    expect(rows[0]?.submittedCount).toBe(1);
    expect(rows[0]?.ageDays).toBe(5);
  });

  it('never carries anyone’s prose, only their status', async () => {
    h.db.stage.findMany.mockResolvedValue([stage([{ authorId: 'a', status: 'DRAFT' }])]);

    await listOutstandingFeedback(user('HIRING_MANAGER'), now);

    const select = h.db.stage.findMany.mock.calls[0]?.[0]?.select as {
      feedback: { select: Record<string, unknown> };
    };
    expect(Object.keys(select.feedback.select).sort()).toEqual(['authorId', 'status']);
  });

  it('drops a round where every panellist has reported', async () => {
    h.db.stage.findMany.mockResolvedValue([
      stage([
        { authorId: 'a', status: 'SUBMITTED' },
        { authorId: 'b', status: 'SUBMITTED' },
      ]),
    ]);

    expect(await listOutstandingFeedback(user('ADMIN'), now)).toEqual([]);
  });
});

describe('resolveSubmissionScope and getSubmissionNotes', () => {
  function mockSubmission() {
    h.db.submission.findUnique.mockResolvedValue({
      id: 'sub1',
      candidateId: 'cand1',
      interviewId: 'int1',
    });
  }

  it('refuses a candidate outright', async () => {
    mockSubmission();

    expect(await resolveSubmissionScope(user('CANDIDATE', 'cand1'), 'sub1')).toBeNull();
    expect(await getSubmissionNotes(user('CANDIDATE', 'cand1'), 'sub1')).toEqual([]);
    expect(h.db.submissionNote.findMany).not.toHaveBeenCalled();
  });

  it('lets an interviewer through only via a panel seat on the owning application', async () => {
    mockSubmission();
    h.db.stage.findFirst.mockResolvedValue({ applicationId: 'app1' });
    h.db.stageInterviewer.findFirst.mockResolvedValue(null);

    expect(await resolveSubmissionScope(user('INTERVIEWER'), 'sub1')).toBeNull();

    h.db.stageInterviewer.findFirst.mockResolvedValue({ id: 'seat1' });
    expect(await resolveSubmissionScope(user('INTERVIEWER'), 'sub1')).toEqual({
      submissionId: 'sub1',
      applicationId: 'app1',
    });
  });

  /** A bare assessment nobody has built a pipeline around yet. */
  it('falls back to VIEW_ALL_APPLICATIONS when the submission has no application', async () => {
    mockSubmission();
    h.db.stage.findFirst.mockResolvedValue(null);

    expect(await resolveSubmissionScope(user('RECRUITER'), 'sub1')).toEqual({
      submissionId: 'sub1',
      applicationId: null,
    });
    expect(await resolveSubmissionScope(user('INTERVIEWER'), 'sub1')).toBeNull();
  });

  it('marks only the reader’s own notes as deletable', async () => {
    mockSubmission();
    h.db.stage.findFirst.mockResolvedValue(null);
    h.db.submissionNote.findMany.mockResolvedValue([
      {
        id: 'n1',
        body: 'mine',
        lineStart: 4,
        lineEnd: 8,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        authorId: 'viewer',
        author: { name: 'Viewer' },
      },
      {
        id: 'n2',
        body: 'theirs',
        lineStart: null,
        lineEnd: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        authorId: 'other',
        author: { name: 'Other' },
      },
    ]);

    const notes = await getSubmissionNotes(user('ADMIN'), 'sub1');

    expect(notes.map((n) => n.canDelete)).toEqual([true, false]);
  });

  it('returns nothing for a submission that does not exist', async () => {
    h.db.submission.findUnique.mockResolvedValue(null);

    expect(await getSubmissionNotes(user('ADMIN'), 'nope')).toEqual([]);
  });
});

/**
 * A coding round has two writers — a recruiter setting `Stage.status` and the
 * candidate's own workspace moving the assignment — and `stage-status.ts`
 * claims the two can never be seen to disagree because every read model
 * returns the overlay. This module used not to, so the same round read
 * "Awaiting feedback" on the board and "Pending" here.
 */
describe('the stored status is never what a reader is shown', () => {
  it('overlays a coding round with what the candidate actually did', async () => {
    mockStage({
      blind: false,
      panel: ['viewer'],
      feedback: [],
      type: 'CODING_ASSESSMENT',
      status: 'PENDING',
      assignment: { interviewId: 'int1', candidateId: 'cand1', status: 'COMPLETED' },
    });
    h.db.submission.findMany.mockResolvedValue([]);

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.stage.status).toBe('AWAITING_FEEDBACK');
  });

  it('leaves a round that is not an assessment exactly as stored', async () => {
    mockStage({ blind: false, panel: ['viewer'], feedback: [], status: 'SCHEDULED' });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.stage.status).toBe('SCHEDULED');
  });

  it('overlays the queue and the chase list too', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([
      {
        stage: {
          id: 'coding',
          name: 'Take-home',
          type: 'CODING_ASSESSMENT',
          status: 'PENDING',
          scheduledAt: null,
          completedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          assignment: { status: 'COMPLETED' },
          application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
          feedback: [],
        },
      },
    ]);
    const mine = await listMyFeedback(user('INTERVIEWER'), new Date('2026-01-10T00:00:00Z'));
    expect(mine[0]?.stageStatus).toBe('AWAITING_FEEDBACK');

    h.db.stage.findMany.mockResolvedValue([
      {
        id: 'coding',
        name: 'Take-home',
        type: 'CODING_ASSESSMENT',
        status: 'PENDING',
        scheduledAt: null,
        completedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        assignment: { status: 'COMPLETED' },
        application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
        interviewers: [
          { userId: 'a', role: 'PANELIST', user: { name: 'Alice', email: 'a@example.com' } },
        ],
        feedback: [],
      },
    ]);
    const chase = await listOutstandingFeedback(
      user('RECRUITER'),
      new Date('2026-01-10T00:00:00Z'),
    );

    // Stored `PENDING` would have filtered this round out as not yet due; the
    // assessment has in fact been submitted and somebody owes a review.
    expect(chase[0]?.stageStatus).toBe('AWAITING_FEEDBACK');
    expect(chase[0]?.owed.map((person) => person.userId)).toEqual(['a']);
  });
});

/**
 * A shadow is an observer. The denominator excluded them while the numerator
 * counted every submitted row, so a keen shadow made a two-person panel render
 * "3 of 2 submitted".
 */
describe('the panel denominator', () => {
  it('does not expect a scorecard from a shadow', async () => {
    mockStage({
      blind: false,
      panel: ['viewer', 'other', { userId: 'learner', role: 'SHADOW' }],
      feedback: [{ id: 'f-viewer', authorId: 'viewer', status: 'SUBMITTED' }],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.progress).toEqual({ panelSize: 2, submittedCount: 1, outstandingCount: 1 });
    // The seat itself is still shown — the shadow is in the room.
    expect(view?.panel.map((member) => member.userId)).toContain('learner');
  });

  it('does not count one either, so submitted can never exceed expected', async () => {
    mockStage({
      blind: false,
      panel: ['viewer', 'other', { userId: 'learner', role: 'SHADOW' }],
      feedback: [
        { id: 'f-viewer', authorId: 'viewer', status: 'SUBMITTED' },
        { id: 'f-other', authorId: 'other', status: 'SUBMITTED' },
        { id: 'f-learner', authorId: 'learner', status: 'SUBMITTED' },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.progress).toEqual({ panelSize: 2, submittedCount: 2, outstandingCount: 0 });
    expect(view?.progress.submittedCount).toBeLessThanOrEqual(view?.progress.panelSize ?? 0);
  });

  it('never chases a shadow for a scorecard', async () => {
    h.db.stage.findMany.mockResolvedValue([
      {
        id: 'stage1',
        name: 'Round',
        type: 'BEHAVIORAL',
        status: 'AWAITING_FEEDBACK',
        scheduledAt: null,
        completedAt: new Date('2026-01-05T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
        assignment: null,
        application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
        interviewers: [
          { userId: 'a', role: 'PANELIST', user: { name: 'Alice', email: 'a@example.com' } },
          { userId: 'learner', role: 'SHADOW', user: { name: 'Lee', email: 'l@example.com' } },
        ],
        feedback: [{ authorId: 'learner', status: 'SUBMITTED' }],
      },
    ]);

    const rows = await listOutstandingFeedback(user('RECRUITER'), new Date('2026-01-10T00:00:00Z'));

    expect(rows[0]?.owed.map((person) => person.userId)).toEqual(['a']);
    expect(rows[0]?.panelSize).toBe(1);
    // The shadow's scorecard exists and is not part of the fraction.
    expect(rows[0]?.submittedCount).toBe(0);
  });
});

/** Nobody is late for an interview that has not happened. */
describe('a scorecard is not due until the round has run', () => {
  const now = new Date('2026-02-01T00:00:00Z');

  it('lists a round still to come without an age', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([
      {
        stage: {
          id: 'upcoming',
          name: 'Onsite',
          type: 'BEHAVIORAL',
          status: 'SCHEDULED',
          scheduledAt: new Date('2026-02-14T00:00:00Z'),
          completedAt: null,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          assignment: null,
          application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
          feedback: [],
        },
      },
    ]);

    const rows = await listMyFeedback(user('INTERVIEWER'), now);

    expect(rows[0]?.due).toBe(false);
    expect(rows[0]?.ageDays).toBeNull();
  });

  it('sorts a due round ahead of one that has not happened', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([
      {
        stage: {
          id: 'upcoming',
          name: 'Onsite',
          type: 'BEHAVIORAL',
          status: 'SCHEDULED',
          scheduledAt: null,
          completedAt: null,
          // Older than the due round, and still second: not due is not late.
          createdAt: new Date('2025-12-01T00:00:00Z'),
          assignment: null,
          application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
          feedback: [],
        },
      },
      {
        stage: {
          id: 'ran',
          name: 'Screen',
          type: 'BEHAVIORAL',
          status: 'AWAITING_FEEDBACK',
          scheduledAt: null,
          completedAt: new Date('2026-01-20T00:00:00Z'),
          createdAt: new Date('2026-01-01T00:00:00Z'),
          assignment: null,
          application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
          feedback: [],
        },
      },
    ]);

    const rows = await listMyFeedback(user('INTERVIEWER'), now);

    expect(rows.map((row) => row.stageId)).toEqual(['ran', 'upcoming']);
    expect(rows[0]?.ageDays).toBe(12);
  });

  it('keeps a round nobody has sat off the chase list entirely', async () => {
    h.db.stage.findMany.mockResolvedValue([
      {
        id: 'upcoming',
        name: 'Onsite',
        type: 'BEHAVIORAL',
        status: 'SCHEDULED',
        scheduledAt: new Date('2026-02-14T00:00:00Z'),
        completedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        assignment: null,
        application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
        interviewers: [
          { userId: 'a', role: 'PANELIST', user: { name: 'Alice', email: 'a@example.com' } },
        ],
        feedback: [],
      },
    ]);

    expect(await listOutstandingFeedback(user('RECRUITER'), now)).toEqual([]);
  });
});

/** Both list queries read unbounded tables; both are now bounded. */
describe('the list queries are bounded', () => {
  it('takes a limit and asks for the oldest rounds first', async () => {
    h.db.stageInterviewer.findMany.mockResolvedValue([]);
    h.db.stage.findMany.mockResolvedValue([]);

    await listMyFeedback(user('INTERVIEWER'), new Date(), 25);
    await listOutstandingFeedback(user('RECRUITER'), new Date(), 40);

    const mine = h.db.stageInterviewer.findMany.mock.calls[0]?.[0] as {
      take: number;
      orderBy: unknown;
    };
    expect(mine.take).toBe(25);
    expect(mine.orderBy).toEqual({ stage: { createdAt: 'asc' } });

    const chase = h.db.stage.findMany.mock.calls[0]?.[0] as {
      take: number;
      orderBy: unknown;
      where: { interviewers: unknown };
    };
    expect(chase.take).toBe(40);
    expect(chase.orderBy).toEqual({ createdAt: 'asc' });
    // A round whose only seats are shadows owes nothing, so it is not read.
    expect(chase.where.interviewers).toEqual({ some: { role: { not: 'SHADOW' } } });
  });
});

/**
 * `FeedbackRevision` was written from the first commit and read by nothing but
 * a `_count`, while the UI promised "the earlier versions are kept".
 */
describe('the revision trail is readable', () => {
  it('returns each prior version, newest first, with who edited it and why', async () => {
    mockStage({
      blind: false,
      panel: ['viewer'],
      feedback: [
        {
          id: 'f-viewer',
          authorId: 'viewer',
          status: 'SUBMITTED',
          revisions: [
            { id: 'rev2', at: '2026-01-09T00:00:00Z', reason: 'Corrected the score.' },
            { id: 'rev1', at: '2026-01-04T00:00:00Z' },
          ],
        },
      ],
    });

    const own = (await getStageForFeedback(user('INTERVIEWER'), 'stage1'))?.own;

    expect(own?.revisionCount).toBe(2);
    expect(own?.lastRevisedAt).toEqual(new Date('2026-01-09T00:00:00Z'));
    expect(own?.revisions.map((revision) => revision.id)).toEqual(['rev2', 'rev1']);
    expect(own?.revisions[0]?.reason).toBe('Corrected the score.');
    expect(own?.revisions[0]?.editedByName).toBe('viewer');
    expect(own?.revisions[0]?.summary).toBe('the first draft from viewer');
    expect(own?.revisions[0]?.recommendation).toBe('LEAN_NO');
    expect(own?.revisions[0]?.scores).toEqual([{ criterionId: 'c1', score: 1, note: '' }]);
  });

  it('reports a snapshot it cannot parse rather than rendering an empty version', async () => {
    mockStage({
      blind: false,
      panel: ['viewer'],
      feedback: [
        {
          id: 'f-viewer',
          authorId: 'viewer',
          status: 'SUBMITTED',
          revisions: [{ id: 'rev1', at: '2026-01-04T00:00:00Z', snapshot: 'not an object' }],
        },
      ],
    });

    const own = (await getStageForFeedback(user('INTERVIEWER'), 'stage1'))?.own;

    expect(own?.revisions[0]?.unreadable).toBe(true);
    expect(own?.revisionCount).toBe(1);
  });

  /**
   * The bypass: submit anything to unlock the panel, read it, then rewrite.
   * `submittedAt` is preserved, so only the trail can say this happened.
   */
  it('says when a revision was made after the panel became readable', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other'],
      feedback: [
        {
          id: 'f-viewer',
          authorId: 'viewer',
          status: 'SUBMITTED',
          submittedAt: '2026-01-02T00:00:00Z',
          revisions: [{ id: 'rev1', at: '2026-01-08T00:00:00Z' }],
        },
        {
          id: 'f-other',
          authorId: 'other',
          status: 'SUBMITTED',
          submittedAt: '2026-01-05T00:00:00Z',
        },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.own?.revisedAfterReadingPanel).toBe(true);
    // The original submission time stands, which is exactly why the flag is
    // needed: nothing else on the card says the content is six days younger.
    expect(view?.own?.submittedAt).toEqual(new Date('2026-01-02T00:00:00Z'));
  });

  it('does not claim it when the author was the only one to have submitted', async () => {
    mockStage({
      blind: true,
      panel: ['viewer', 'other'],
      feedback: [
        {
          id: 'f-viewer',
          authorId: 'viewer',
          status: 'SUBMITTED',
          submittedAt: '2026-01-02T00:00:00Z',
          revisions: [{ id: 'rev1', at: '2026-01-03T00:00:00Z' }],
        },
        { id: 'f-other', authorId: 'other', status: 'DRAFT' },
      ],
    });

    const view = await getStageForFeedback(user('INTERVIEWER'), 'stage1');

    expect(view?.own?.revisedAfterReadingPanel).toBe(false);
  });
});
