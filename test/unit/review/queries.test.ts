import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  return { db: createPrismaMock() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));

import { listReviewQueue } from '@/features/review/queries';
import type { SessionUser } from '@/features/auth/session';
import type { Recommendation, Role } from '@/generated/prisma/enums';

/**
 * The queue's access rules, which are the part a page cannot be trusted to
 * enforce.
 *
 * Two of them are load-bearing and neither is visible by reading the table
 * markup:
 *
 *  1. A cross-candidate list is gated on `VIEW_ALL_APPLICATIONS`, so an
 *     interviewer gets nothing at all — not a filtered list, nothing.
 *  2. The split-panel flag is computed only from scorecards the viewer may
 *     read, and comes back `null` the moment one was withheld. A disagreement
 *     computed over half a panel reads as agreement, which is the failure this
 *     suite exists to prevent.
 */

const NOW_ISH = new Date('2026-03-10T12:00:00Z');
const STARTED = new Date('2026-03-01T09:00:00Z');
const FINISHED = new Date('2026-03-01T10:00:00Z');

function viewer(role: Role, id = 'viewer-1'): SessionUser {
  return { id, role, name: 'Viewer', email: 'viewer@example.com' } as SessionUser;
}

interface SeatSpec {
  userId: string;
  role?: 'LEAD' | 'PANELIST' | 'SHADOW';
}

interface CardSpec {
  authorId: string;
  status?: 'SUBMITTED' | 'DRAFT';
  recommendation?: Recommendation | null;
}

/**
 * One application with one finished coding round.
 *
 * Defaults describe the ordinary case — assessment submitted, three questions,
 * a panel that has not yet split — so each test overrides only the one thing
 * it is about.
 */
function application(
  overrides: {
    id?: string;
    blind?: boolean;
    seats?: SeatSpec[];
    cards?: CardSpec[];
    stageStatus?: 'AWAITING_FEEDBACK' | 'COMPLETE';
  } = {},
) {
  return {
    id: overrides.id ?? 'app-1',
    status: 'ACTIVE',
    candidate: { id: 'cand-1', name: 'Ada Okafor', email: 'ada@example.com', isActive: true },
    jobRole: { title: 'Backend', level: 'L4' },
    owner: { id: 'rec-1', name: 'Priya' },
    decision: null,
    stages: [
      {
        id: 'stage-1',
        name: 'Coding assessment',
        type: 'CODING_ASSESSMENT',
        position: 0,
        status: overrides.stageStatus ?? 'AWAITING_FEEDBACK',
        outcome: null,
        scheduledAt: null,
        updatedAt: FINISHED,
        blindFeedback: overrides.blind ?? true,
        assignment: {
          status: 'COMPLETED',
          startedAt: STARTED,
          completedAt: FINISHED,
          interview: {
            id: 'int-1',
            title: 'Backend screen',
            status: 'PUBLISHED',
            durationMinutes: null,
            _count: { questions: 3 },
          },
        },
        interviewers: (overrides.seats ?? [{ userId: 'seat-a' }, { userId: 'seat-b' }]).map(
          (seat) => ({ userId: seat.userId, role: seat.role ?? 'PANELIST' }),
        ),
        feedback: (overrides.cards ?? []).map((card, index) => ({
          id: `fb-${index}`,
          authorId: card.authorId,
          status: card.status ?? 'SUBMITTED',
          recommendation: card.recommendation ?? null,
        })),
      },
    ],
  };
}

function submission(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    candidateId: 'cand-1',
    interviewId: 'int-1',
    questionId: 'q-1',
    score: 80,
    passedCount: 4,
    totalCount: 5,
    submittedAt: FINISHED,
    trigger: 'MANUAL',
    language: 'JAVASCRIPT',
    ...overrides,
  };
}

/** Wire the three queries `listReviewQueue` makes, in the order it makes them. */
function seed(options: {
  applications: ReturnType<typeof application>[];
  submissions?: ReturnType<typeof submission>[];
  notes?: Array<{ submission: { candidateId: string; interviewId: string } }>;
}) {
  h.db.application.findMany.mockResolvedValue(options.applications);
  h.db.submission.findMany.mockResolvedValue(options.submissions ?? [submission()]);
  h.db.submissionNote.findMany.mockResolvedValue(options.notes ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(NOW_ISH);
});

describe('listReviewQueue — who may open it', () => {
  it('returns nothing to an interviewer, who has no cross-candidate view', async () => {
    seed({ applications: [application()] });

    const queue = await listReviewQueue(viewer('INTERVIEWER'));

    expect(queue.rows).toEqual([]);
    // Not merely filtered to nothing — the database is never asked. A
    // panellist has their own feedback queue; a table of other people's
    // candidates is both a gossip surface and an anchoring one.
    expect(h.db.application.findMany).not.toHaveBeenCalled();
  });

  it('returns nothing to a candidate', async () => {
    seed({ applications: [application()] });

    const queue = await listReviewQueue(viewer('CANDIDATE'));

    expect(queue.rows).toEqual([]);
    expect(h.db.application.findMany).not.toHaveBeenCalled();
  });

  it('serves a recruiter, who owns the process without deciding it', async () => {
    seed({ applications: [application()] });

    const queue = await listReviewQueue(viewer('RECRUITER'));

    expect(queue.rows).toHaveLength(1);
  });
});

describe('listReviewQueue — the blind rule survives aggregation', () => {
  it('withholds the split flag from a panellist who has not submitted', async () => {
    // The viewer sits on this blind round and owes a scorecard. The other two
    // panellists have submitted, and they disagree.
    seed({
      applications: [
        application({
          blind: true,
          seats: [{ userId: 'viewer-1' }, { userId: 'seat-b' }, { userId: 'seat-c' }],
          cards: [
            { authorId: 'seat-b', recommendation: 'STRONG_HIRE' },
            { authorId: 'seat-c', recommendation: 'NO' },
          ],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    // `null`, never `false`. A split computed over the half of the panel this
    // person may read would render as agreement, which is worse than silence.
    expect(queue.rows[0]?.panel.disagrees).toBeNull();
    // The counts are still honest — counting was never the restricted part.
    expect(queue.rows[0]?.panel.submitted).toBe(2);
    expect(queue.rows[0]?.panel.expected).toBe(3);
  });

  it('withholds it from an admin on the panel too — rank does not prevent anchoring', async () => {
    seed({
      applications: [
        application({
          blind: true,
          seats: [{ userId: 'viewer-1' }, { userId: 'seat-b' }],
          cards: [{ authorId: 'seat-b', recommendation: 'STRONG_HIRE' }],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.panel.disagrees).toBeNull();
  });

  it('reports the split to a hiring manager who is not on the panel', async () => {
    // Nobody anchors a judgement they are not writing, which is exactly why
    // the blind rule does not apply to a reader preparing a debrief.
    seed({
      applications: [
        application({
          blind: true,
          seats: [{ userId: 'seat-a' }, { userId: 'seat-b' }],
          cards: [
            { authorId: 'seat-a', recommendation: 'STRONG_HIRE' },
            { authorId: 'seat-b', recommendation: 'NO' },
          ],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('HIRING_MANAGER'));

    expect(queue.rows[0]?.panel.disagrees).toBe(true);
  });

  it('reports the split to a panellist who has already submitted their own', async () => {
    seed({
      applications: [
        application({
          blind: true,
          seats: [{ userId: 'viewer-1' }, { userId: 'seat-b' }],
          cards: [
            { authorId: 'viewer-1', recommendation: 'HIRE' },
            { authorId: 'seat-b', recommendation: 'STRONG_NO' },
          ],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.panel.disagrees).toBe(true);
  });

  it('says a panel agrees only when it actually does', async () => {
    seed({
      applications: [
        application({
          blind: false,
          seats: [{ userId: 'seat-a' }, { userId: 'seat-b' }],
          cards: [
            { authorId: 'seat-a', recommendation: 'HIRE' },
            { authorId: 'seat-b', recommendation: 'HIRE' },
          ],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.panel.disagrees).toBe(false);
  });
});

describe('listReviewQueue — the AGREE facet', () => {
  it('does not treat a withheld signal as agreement', async () => {
    seed({
      applications: [
        application({
          blind: true,
          seats: [{ userId: 'viewer-1' }, { userId: 'seat-b' }],
          cards: [{ authorId: 'seat-b', recommendation: 'HIRE' }],
        }),
      ],
    });

    const queue = await listReviewQueue(viewer('ADMIN'), { panel: 'AGREE' });

    // The row's flag is `null`, and "cannot say" must not answer a filter that
    // asked for "agrees".
    expect(queue.rows).toEqual([]);
  });
});

describe('listReviewQueue — what counts as reviewed', () => {
  it('is unread when no person has written a note or a scorecard', async () => {
    seed({ applications: [application({ cards: [] })], notes: [] });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.codeRead).toBe(false);
    // A machine score nobody has read is not a review, and that is the whole
    // reason this bucket sits above "panel outstanding".
    expect(queue.rows[0]?.loop).toBe('UNREAD');
  });

  it('is read once somebody has left a note on the submission', async () => {
    seed({
      applications: [application({ cards: [] })],
      notes: [{ submission: { candidateId: 'cand-1', interviewId: 'int-1' } }],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.codeRead).toBe(true);
  });

  it('is read once a scorecard has been submitted on the coding round', async () => {
    seed({
      applications: [application({ cards: [{ authorId: 'seat-a' }] })],
      notes: [],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.codeRead).toBe(true);
  });

  it('does not count a draft as having read the code', async () => {
    seed({
      applications: [application({ cards: [{ authorId: 'seat-a', status: 'DRAFT' }] })],
      notes: [],
    });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows[0]?.codeRead).toBe(false);
  });
});

describe('listReviewQueue — eligibility', () => {
  it('drops a hand-resolved round with nothing behind it', async () => {
    // Someone marked the round complete but the candidate never submitted, so
    // there is no code and nothing to review. The `where` cannot express this
    // — it correlates a submission with the assignment's interview — so the
    // read model narrows it in memory, and this is the test that says so.
    seed({
      applications: [
        application({
          stageStatus: 'COMPLETE',
        }),
      ],
      submissions: [],
    });
    // Override the assignment so the machine never claimed completion either.
    const apps = [application({ stageStatus: 'COMPLETE' })];
    apps[0]!.stages[0]!.assignment.status = 'ASSIGNED';
    h.db.application.findMany.mockResolvedValue(apps);
    h.db.submission.findMany.mockResolvedValue([]);

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows).toEqual([]);
  });

  it('keeps a completed assessment even with no submissions loaded', async () => {
    // The assignment says the machine saw every question answered. Trusting it
    // matters: a submission the query missed must not make a finished
    // assessment vanish from the only queue that lists it.
    seed({ applications: [application()], submissions: [] });

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0]?.assessment.rollUp.score).toBeNull();
  });
});

describe('listReviewQueue — ordering and counts', () => {
  it('defaults to waiting longest, not to the highest score', async () => {
    const older = application({ id: 'app-old' });
    older.stages[0]!.assignment.completedAt = new Date('2026-02-20T10:00:00Z');
    older.candidate = { ...older.candidate, id: 'cand-2', name: 'Bo' };

    const newer = application({ id: 'app-new' });

    h.db.application.findMany.mockResolvedValue([newer, older]);
    h.db.submission.findMany.mockResolvedValue([
      // The newer application scores far higher; it must still sort second.
      submission({ candidateId: 'cand-1', score: 100, passedCount: 5 }),
      submission({ candidateId: 'cand-2', score: 10, passedCount: 1 }),
    ]);
    h.db.submissionNote.findMany.mockResolvedValue([]);

    const queue = await listReviewQueue(viewer('ADMIN'));

    expect(queue.rows.map((row) => row.applicationId)).toEqual(['app-old', 'app-new']);
    expect(queue.sort).toBe('waiting');
  });

  it('counts the loop steps before the loop filter is applied', async () => {
    // So that picking one chip never changes the number on the others.
    seed({ applications: [application()] });

    const queue = await listReviewQueue(viewer('ADMIN'), { loop: 'READY' });

    expect(queue.rows).toEqual([]);
    expect(queue.loopCounts.UNREAD).toBe(1);
  });

  it('hides closed applications unless they are asked for', async () => {
    const closed = application();
    closed.status = 'REJECTED';
    seed({ applications: [closed] });

    await expect(listReviewQueue(viewer('ADMIN'))).resolves.toMatchObject({ rows: [] });
    await expect(listReviewQueue(viewer('ADMIN'), { includeClosed: true })).resolves.toMatchObject({
      rows: [expect.objectContaining({ loop: 'CLOSED' })],
    });
    await expect(listReviewQueue(viewer('ADMIN'), { loop: 'CLOSED' })).resolves.toMatchObject({
      rows: [expect.objectContaining({ loop: 'CLOSED' })],
    });
  });
});

describe('listReviewQueue — what it never loads', () => {
  it('never selects source code or stored results', async () => {
    seed({ applications: [application()] });

    await listReviewQueue(viewer('ADMIN'));

    const select = h.db.submission.findMany.mock.calls[0]?.[0]?.select ?? {};
    // A hundred-row list has no business pulling a hundred programs and their
    // full per-test JSON across the wire; the code is a screen of its own.
    expect(select).not.toHaveProperty('sourceCode');
    expect(select).not.toHaveProperty('results');
  });

  it('never selects the prose of a scorecard', async () => {
    seed({ applications: [application()] });

    await listReviewQueue(viewer('ADMIN'));

    const select = h.db.application.findMany.mock.calls[0]?.[0]?.select ?? {};
    const feedbackSelect = select.stages?.select?.feedback?.select ?? {};
    // `recommendation` is the one deliberate exception, and it is an enum.
    expect(Object.keys(feedbackSelect).sort()).toEqual([
      'authorId',
      'id',
      'recommendation',
      'status',
    ]);
    expect(feedbackSelect).not.toHaveProperty('summary');
    expect(feedbackSelect).not.toHaveProperty('strengths');
    expect(feedbackSelect).not.toHaveProperty('concerns');
  });
});
