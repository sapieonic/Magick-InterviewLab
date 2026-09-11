import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionUser } from '@/features/auth/session';
import type { Role } from '@/generated/prisma/enums';

// `@/lib/audit` is server-only and opens a connection pool through Prisma at
// module scope; the AUDIT action constants it exports are plain data, so both
// are stubbed rather than the constants being duplicated here and left to drift.
vi.mock('server-only', () => ({}));

const { db } = await vi.hoisted(async () => ({
  db: (await import('../../helpers/prisma-mock')).createPrismaMock(),
}));
vi.mock('@/lib/db/prisma', () => ({ prisma: db }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  ACTIVITY_PHRASES,
  actionLabel,
  describeAction,
  isQuietAction,
} from '@/features/dashboard/activity';
import { getDashboardTiles, getPipelineActivity } from '@/features/dashboard/queries';
import { AUDIT } from '@/lib/audit';

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

beforeEach(() => {
  resetPrismaMock(db);
});

describe('describeAction', () => {
  it('has a phrase for every audit action the app can write', () => {
    for (const action of Object.values(AUDIT)) {
      const phrase = describeAction(action);
      expect(phrase.verb).toMatch(/\S/);
      // A fallback would echo the action string; a real phrase never does.
      expect(phrase.verb).not.toContain('.');
    }
  });

  /**
   * A newer deploy can write an action an older reader has never heard of.
   * Dropping the row would silently shorten an audit trail, which is the one
   * thing an audit trail must not do.
   */
  it('degrades an unknown action into something readable rather than dropping it', () => {
    const phrase = describeAction('offer.extended_verbally');
    expect(phrase.verb).toBe('extended verbally');
    expect(phrase.tone).toBe('neutral');
  });

  it('marks a reversal as needing attention, not as routine', () => {
    expect(describeAction(AUDIT.DECISION_CHANGED).tone).toBe('attention');
    expect(describeAction(AUDIT.FEEDBACK_REVISED).tone).toBe('attention');
  });

  it('marks a landed scorecard and a recorded decision as progress', () => {
    expect(describeAction(AUDIT.FEEDBACK_SUBMITTED).tone).toBe('positive');
    expect(describeAction(AUDIT.DECISION_RECORDED).tone).toBe('positive');
  });
});

describe('isQuietAction', () => {
  /**
   * A saved draft is not evidence yet, and a feed that announces every
   * autosave drowns the events that matter.
   */
  it('keeps draft autosaves out of the shared feed', () => {
    expect(isQuietAction(AUDIT.FEEDBACK_SAVED)).toBe(true);
  });

  it('lets everything else through', () => {
    for (const action of Object.values(AUDIT)) {
      if (action === AUDIT.FEEDBACK_SAVED) continue;
      expect(isQuietAction(action)).toBe(false);
    }
  });
});

/**
 * One map, two grammars. The feed narrates ("Priya moved a round"), the
 * application timeline lists ("Round status changed"), and when those lived in
 * two files they drifted — the same row read "added a stage" in one and
 * "Round added" in the other.
 */
describe('ACTIVITY_PHRASES', () => {
  it('carries both a verb and a label for every action the app can write', () => {
    for (const action of Object.values(AUDIT)) {
      const phrase = ACTIVITY_PHRASES[action];
      expect(phrase).toBeDefined();
      expect(phrase.label).toMatch(/\S/);
      expect(actionLabel(action)).toBe(phrase.label);
    }
  });

  /** The UI says "round"; only the schema says "stage". */
  it('speaks of rounds rather than stages', () => {
    const stageActions = Object.values(AUDIT).filter((action) => action.startsWith('stage.'));
    expect(stageActions.length).toBeGreaterThan(0);
    for (const action of stageActions) {
      const phrase = ACTIVITY_PHRASES[action];
      expect(phrase.verb).toContain('round');
      expect(`${phrase.verb} ${phrase.label}`.toLowerCase()).not.toContain('stage');
    }
  });

  it('still labels an action it has never heard of', () => {
    expect(actionLabel('offer.extended_verbally')).toBe('Extended verbally');
  });
});

// --- dashboard tiles --------------------------------------------------------

/**
 * A tile counts exactly what its destination lists.
 *
 * A number that cannot be reconciled with the page behind it is worse than no
 * number: a shadow told they owe a scorecard clicks through to a round they are
 * not expected to score, and a recruiter told "14 — chase these" lands on six.
 * So these assertions are about the two rules in `stage-status.ts` that both
 * the tiles and the feedback queues are built from.
 */
function tileValue(tiles: Array<{ key: string; value: number }>, key: string): number {
  const tile = tiles.find((row) => row.key === key);
  if (!tile) throw new Error(`no ${key} tile`);
  return tile.value;
}

function tileHref(tiles: Array<{ key: string; href: string }>, key: string): string {
  const tile = tiles.find((row) => row.key === key);
  if (!tile) throw new Error(`no ${key} tile`);
  return tile.href;
}

interface SeatFixture {
  role?: 'LEAD' | 'PANELIST' | 'SHADOW';
  type?: 'CODING_ASSESSMENT' | 'TECHNICAL_INTERVIEW';
  status?: 'PENDING' | 'SCHEDULED' | 'IN_PROGRESS' | 'AWAITING_FEEDBACK' | 'COMPLETE';
  assignment?: 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | null;
  submitted?: boolean;
}

function seat(fixture: SeatFixture = {}) {
  return {
    role: fixture.role ?? 'PANELIST',
    stage: {
      type: fixture.type ?? 'TECHNICAL_INTERVIEW',
      status: fixture.status ?? 'COMPLETE',
      assignment: fixture.assignment ? { status: fixture.assignment } : null,
      // The query selects only this viewer's submitted rows, so presence is
      // the whole signal.
      feedback: fixture.submitted ? [{ id: 'f-1' }] : [],
    },
  };
}

describe('getDashboardTiles — scorecards you owe', () => {
  async function owed(seats: ReturnType<typeof seat>[]): Promise<number> {
    db.stageInterviewer.findMany.mockResolvedValue(seats);
    const tiles = await getDashboardTiles(user('INTERVIEWER'));
    return tileValue(tiles, 'my-feedback');
  }

  /**
   * A shadow is an observer: they are on the round to learn, not to judge. A
   * red "Scorecards you owe: 1" sends them to a round nobody expects them to
   * score — and the panel's denominator never counted them anyway.
   */
  it('never tells a shadow they owe a scorecard', async () => {
    expect(await owed([seat({ role: 'SHADOW', status: 'COMPLETE' })])).toBe(0);
  });

  /** A scorecard for a round that has not happened is not late, it is not due. */
  it.each([['PENDING'], ['SCHEDULED']] as const)(
    'does not count a %s round nobody has sat yet',
    async (status) => {
      expect(await owed([seat({ status })])).toBe(0);
    },
  );

  it.each([['IN_PROGRESS'], ['AWAITING_FEEDBACK'], ['COMPLETE']] as const)(
    'counts a %s round the viewer has not scored',
    async (status) => {
      expect(await owed([seat({ status })])).toBe(1);
    },
  );

  /**
   * The stored status of a coding round is only what a human last typed. The
   * candidate has submitted, so somebody owes a review — and counting the
   * stored `PENDING` left exactly this round out of every tile.
   */
  it('counts a coding round the candidate has already submitted', async () => {
    expect(
      await owed([seat({ type: 'CODING_ASSESSMENT', status: 'PENDING', assignment: 'COMPLETED' })]),
    ).toBe(1);
  });

  it('does not count a coding round the candidate has not started', async () => {
    expect(
      await owed([seat({ type: 'CODING_ASSESSMENT', status: 'PENDING', assignment: 'ASSIGNED' })]),
    ).toBe(0);
  });

  it('drops a round the viewer has already submitted', async () => {
    expect(await owed([seat({ submitted: true })])).toBe(0);
  });

  /** The same restriction the queue on /admin/feedback applies: a closed
   *  application's unwritten scorecard is history, not a task. */
  it('asks only for un-skipped rounds of open applications', async () => {
    await owed([]);

    const call = db.stageInterviewer.findMany.mock.calls[0]?.[0] as {
      where: { userId: string; stage: Record<string, unknown> };
    };
    expect(call.where.userId).toBe('viewer');
    expect(call.where.stage).toMatchObject({
      status: { not: 'SKIPPED' },
      application: { status: { in: ['ACTIVE', 'ON_HOLD'] } },
    });
  });
});

describe('getDashboardTiles — rounds awaiting feedback', () => {
  interface StageFixture {
    status?: 'PENDING' | 'AWAITING_FEEDBACK' | 'COMPLETE';
    seats: Array<{ userId: string; role: 'LEAD' | 'PANELIST' | 'SHADOW' }>;
    submittedBy?: string[];
  }

  function stage(fixture: StageFixture) {
    return {
      type: 'TECHNICAL_INTERVIEW',
      status: fixture.status ?? 'AWAITING_FEEDBACK',
      assignment: null,
      interviewers: fixture.seats,
      feedback: (fixture.submittedBy ?? []).map((authorId) => ({
        authorId,
        status: 'SUBMITTED',
      })),
    };
  }

  async function tiles(stages: ReturnType<typeof stage>[]) {
    db.stageInterviewer.findMany.mockResolvedValue([]);
    db.stage.findMany.mockResolvedValue(stages);
    db.application.count.mockResolvedValue(0);
    return getDashboardTiles(user('RECRUITER'));
  }

  it('counts a round somebody expected to score has not', async () => {
    const result = await tiles([stage({ seats: [{ userId: 'u-1', role: 'PANELIST' }] })]);
    expect(tileValue(result, 'awaiting-feedback')).toBe(1);
  });

  /** A shadow's silence is not an outstanding scorecard, so the round is done. */
  it('does not chase a round whose only gap is a shadow', async () => {
    const result = await tiles([
      stage({
        seats: [
          { userId: 'u-1', role: 'PANELIST' },
          { userId: 'u-2', role: 'SHADOW' },
        ],
        submittedBy: ['u-1'],
      }),
    ]);
    expect(tileValue(result, 'awaiting-feedback')).toBe(0);
  });

  it('does not chase a round that has not been sat', async () => {
    const result = await tiles([
      stage({ status: 'PENDING', seats: [{ userId: 'u-1', role: 'PANELIST' }] }),
    ]);
    expect(tileValue(result, 'awaiting-feedback')).toBe(0);
  });

  it('restricts to un-skipped rounds of open applications, as the chase list does', async () => {
    await tiles([]);

    const call = db.stage.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      status: { not: 'SKIPPED' },
      application: { status: { in: ['ACTIVE', 'ON_HOLD'] } },
      interviewers: { some: {} },
    });
  });

  /** The work this number describes is per round and per person, which is the
   *  chase list — the board shows applications. */
  it('sends the reader to the chase list rather than the board', async () => {
    const result = await tiles([]);
    expect(tileHref(result, 'awaiting-feedback')).toBe('/admin/feedback');
  });

  it('links the active tile to the filter it actually counted', async () => {
    const result = await tiles([]);
    expect(tileHref(result, 'active')).toBe('/admin/pipeline?status=ACTIVE');
  });
});

// --- the activity feed ------------------------------------------------------

describe('getPipelineActivity', () => {
  function auditRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'e-1',
      action: AUDIT.RUBRIC_PUBLISHED,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      applicationId: null,
      actor: { name: 'Priya' },
      application: null,
      ...overrides,
    };
  }

  function whereArg(): Record<string, unknown> {
    const call = db.auditEvent.findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    return call.where;
  }

  /**
   * `{ application: <fragment> }` on a nullable to-one requires the relation to
   * be *present*, so an event recorded without an `applicationId` matched
   * nothing — for an admin too, whose fragment is the empty `{}`. The phrase
   * written for `rubric.published` was unreachable.
   */
  it('lets an application-less event reach a viewer who sees every application', async () => {
    db.auditEvent.findMany.mockResolvedValue([auditRow()]);

    const items = await getPipelineActivity(user('ADMIN'));

    expect(whereArg()).toEqual({
      OR: [{ application: {} }, { applicationId: null }],
    });
    expect(items[0]?.verb).toBe('published a rubric version');
    expect(items[0]?.applicationId).toBeNull();
    expect(items[0]?.candidateName).toBeNull();
  });

  /**
   * The other half: an unscoped event must not become a hole in the
   * per-application scoping. An interviewer sees the candidates they hold a
   * seat on, and nothing that was never scoped to a candidate at all.
   */
  it('never lets an application-less event past an interviewer’s scoping', async () => {
    db.auditEvent.findMany.mockResolvedValue([]);

    await getPipelineActivity(user('INTERVIEWER', 'int-1'));

    expect(whereArg()).toEqual({
      application: { stages: { some: { interviewers: { some: { userId: 'int-1' } } } } },
    });
    expect(whereArg()['OR']).toBeUndefined();
  });

  it('keeps a candidate at an unsatisfiable filter, application-less rows included', async () => {
    db.auditEvent.findMany.mockResolvedValue([]);

    await getPipelineActivity(user('CANDIDATE', 'cand-1'));

    expect(whereArg()).toEqual({ application: { id: { in: [] } } });
  });
});
