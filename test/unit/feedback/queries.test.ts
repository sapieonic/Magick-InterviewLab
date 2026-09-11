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

interface FeedbackFixture {
  id: string;
  authorId: string;
  status: 'DRAFT' | 'SUBMITTED';
  summary?: string;
}

function feedbackRow(fixture: FeedbackFixture) {
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
    submittedAt: fixture.status === 'SUBMITTED' ? new Date('2026-01-02T00:00:00Z') : null,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    author: { name: fixture.authorId },
    scores: [{ criterionId: 'c1', score: 3, note: '' }],
    _count: { revisions: 0 },
  };
}

/**
 * Two different `stage.findUnique` calls run on this path — the panel-seat
 * lookup in `access.ts` and the full read here — so the mock answers by the
 * shape of the select rather than by call order.
 */
function mockStage(options: {
  blind: boolean;
  panel: string[];
  feedback: FeedbackFixture[];
  type?: 'CODING_ASSESSMENT' | 'BEHAVIORAL';
  assignment?: { interviewId: string; candidateId: string } | null;
}) {
  const rows = options.feedback.map(feedbackRow);
  h.db.stage.findUnique.mockImplementation((args: { select: Record<string, unknown> }) => {
    if (args.select['application'] === undefined) {
      return Promise.resolve({
        id: 'stage1',
        applicationId: 'app1',
        blindFeedback: options.blind,
        interviewers: options.panel.includes('viewer') ? [{ id: 'seat-viewer' }] : [],
      });
    }
    return Promise.resolve({
      id: 'stage1',
      name: 'System design',
      type: options.type ?? 'BEHAVIORAL',
      status: 'AWAITING_FEEDBACK',
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
      interviewers: options.panel.map((userId) => ({
        userId,
        role: 'PANELIST',
        user: { name: userId, email: `${userId}@example.com` },
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
  }) {
    return {
      stage: {
        id: options.id,
        name: options.id,
        type: 'BEHAVIORAL',
        status: 'AWAITING_FEEDBACK',
        scheduledAt: null,
        completedAt: options.completedAt ? new Date(options.completedAt) : null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
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

  function stage(feedback: Array<{ authorId: string; status: 'DRAFT' | 'SUBMITTED' }>) {
    return {
      id: 'stage1',
      name: 'Round',
      type: 'BEHAVIORAL',
      status: 'AWAITING_FEEDBACK',
      scheduledAt: null,
      completedAt: new Date('2026-01-05T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      application: { id: 'app1', candidate: { name: 'Ada' }, jobRole: null },
      interviewers: [
        { userId: 'a', user: { name: 'Alice', email: 'a@example.com' } },
        { userId: 'b', user: { name: 'Bob', email: 'b@example.com' } },
      ],
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
