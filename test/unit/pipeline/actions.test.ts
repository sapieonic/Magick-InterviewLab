import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';

/** The failure branch of the discriminated union, so `.error` is reachable. */
type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { mockRedirect } = await import('../../helpers/next-mocks');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    redirect: vitest.fn(mockRedirect),
    revalidatePath: vitest.fn(),
    getCurrentUser: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
// Only the session lookup is faked. `requireCapability` and the capability
// table are the controls under test, so the real guard — and the real error
// `actionGuard` matches on by identity — stays in the path.
vi.mock('@/features/auth/session', () => ({
  getCurrentUser: h.getCurrentUser,
  destroyAllSessionsFor: vi.fn(),
}));
// `@/lib/audit` is deliberately NOT mocked: it writes through the same Prisma
// mock, so "did this transition record an event" is an assertion about a real
// call rather than about a stub someone could forget to wire up.

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  addPanelistAction,
  createApplicationAction,
  createStageAction,
  deleteStageAction,
  recordStageOutcomeAction,
  removePanelistAction,
  reorderStagesAction,
  setApplicationStatusAction,
  setStageStatusAction,
} from '@/features/pipeline/actions';

function actor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'recruiter-1',
    name: 'Priya',
    email: 'priya@example.com',
    role: 'RECRUITER',
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function failed(result: ActionResult<unknown>): ActionFailure {
  if (result.ok) throw new Error('expected the action to fail');
  return result;
}

function succeeded(result: ActionResult<unknown>): void {
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
}

/** Every `data` argument passed to `prisma.stage.update`, in call order. */
function stageUpdates(): Array<{ where: { id: string }; data: Record<string, unknown> }> {
  return h.db.stage.update.mock.calls.map(
    (call) => call[0] as { where: { id: string }; data: Record<string, unknown> },
  );
}

function auditActions(): string[] {
  return h.db.auditEvent.create.mock.calls.map(
    (call) => (call[0] as { data: { action: string } }).data.action,
  );
}

/** The stage row `loadStage` expects back. */
function stageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stage-2',
    applicationId: 'app-1',
    name: 'Technical screen',
    type: 'LIVE_CODING',
    position: 1,
    status: 'AWAITING_FEEDBACK',
    assignment: null,
    application: { candidateId: 'cand-1' },
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.redirect.mockClear();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('authorization', () => {
  it('refuses an interviewer and writes nothing', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'int-1', role: 'INTERVIEWER' }));

    const result = failed(
      await createStageAction(
        null,
        form({ applicationId: 'app-1', name: 'Screen', type: 'LIVE_CODING' }),
      ),
    );

    expect(result.error).toMatch(/permission/i);
    expect(h.db.stage.create).not.toHaveBeenCalled();
  });
});

describe('one active application per candidate and role', () => {
  it('refuses a second active application for the same job role', async () => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1' });
    h.db.jobRole.findUnique.mockResolvedValue({ id: 'role-1' });
    // The clash the database cannot express.
    h.db.application.findFirst.mockResolvedValue({ id: 'app-existing' });

    const result = failed(
      await createApplicationAction(null, form({ candidateId: 'cand-1', jobRoleId: 'role-1' })),
    );

    expect(result.error).toMatch(/already has an active application/i);
    expect(h.db.application.create).not.toHaveBeenCalled();
  });

  it('scopes the check to the candidate, the role and ACTIVE only', async () => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1' });
    h.db.jobRole.findUnique.mockResolvedValue({ id: 'role-1' });
    h.db.application.findFirst.mockResolvedValue(null);
    h.db.application.create.mockResolvedValue({ id: 'app-new' });

    // `redirect` throws by design, and `actionGuard` re-throws it.
    await expect(
      createApplicationAction(null, form({ candidateId: 'cand-1', jobRoleId: 'role-1' })),
    ).rejects.toThrow(/NEXT_REDIRECT/);

    const where = (h.db.application.findFirst.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toMatchObject({ candidateId: 'cand-1', jobRoleId: 'role-1', status: 'ACTIVE' });
    expect(auditActions()).toContain('application.created');
  });

  it('re-checks the clash when an application is reopened', async () => {
    h.db.application.findUnique.mockResolvedValue({
      id: 'app-1',
      candidateId: 'cand-1',
      jobRoleId: 'role-1',
      status: 'REJECTED',
    });
    h.db.application.findFirst.mockResolvedValue({ id: 'app-other' });

    const result = failed(
      await setApplicationStatusAction(null, form({ id: 'app-1', status: 'ACTIVE' })),
    );

    expect(result.error).toMatch(/already has an active application/i);
    expect(h.db.application.update).not.toHaveBeenCalled();
  });

  it('stamps closedAt when closing and clears it when reopening', async () => {
    h.db.application.findUnique.mockResolvedValue({
      id: 'app-1',
      candidateId: 'cand-1',
      jobRoleId: null,
      status: 'ACTIVE',
    });

    succeeded(await setApplicationStatusAction(null, form({ id: 'app-1', status: 'REJECTED' })));

    const closing = h.db.application.update.mock.calls[0]?.[0] as {
      data: { closedAt: Date | null };
    };
    expect(closing.data.closedAt).toBeInstanceOf(Date);

    h.db.application.update.mockClear();
    h.db.application.findUnique.mockResolvedValue({
      id: 'app-1',
      candidateId: 'cand-1',
      jobRoleId: null,
      status: 'REJECTED',
    });
    h.db.application.findFirst.mockResolvedValue(null);

    succeeded(await setApplicationStatusAction(null, form({ id: 'app-1', status: 'ACTIVE' })));

    const reopening = h.db.application.update.mock.calls[0]?.[0] as {
      data: { closedAt: Date | null };
    };
    expect(reopening.data.closedAt).toBeNull();
  });
});

describe('createStageAction', () => {
  beforeEach(() => {
    h.db.application.findUnique.mockResolvedValue({
      id: 'app-1',
      candidateId: 'cand-1',
      status: 'ACTIVE',
      _count: { stages: 2 },
    });
  });

  it('refuses an assessment on a round that is not a coding assessment', async () => {
    const result = failed(
      await createStageAction(
        null,
        form({
          applicationId: 'app-1',
          name: 'Systems chat',
          type: 'SYSTEM_DESIGN',
          interviewId: 'interview-1',
        }),
      ),
    );

    expect(result.error).toMatch(/only a coding assessment/i);
    expect(result.fieldErrors?.['interviewId']).toBeTruthy();
    expect(h.db.stage.create).not.toHaveBeenCalled();
    // The point of refusing rather than ignoring: no assignment is created
    // behind the author's back either.
    expect(h.db.interviewAssignment.create).not.toHaveBeenCalled();
  });

  it('appends at the next free position', async () => {
    h.db.stage.create.mockResolvedValue({ id: 'stage-3' });

    succeeded(
      await createStageAction(
        null,
        form({ applicationId: 'app-1', name: 'Systems chat', type: 'SYSTEM_DESIGN' }),
      ),
    );

    const created = h.db.stage.create.mock.calls[0]?.[0] as { data: { position: number } };
    expect(created.data.position).toBe(2);
    expect(auditActions()).toContain('stage.created');
  });

  it('reuses an existing assignment and refuses one already backing another round', async () => {
    h.db.interview.findUnique.mockResolvedValue({ id: 'interview-1', status: 'PUBLISHED' });
    h.db.interviewAssignment.findUnique.mockResolvedValue({
      id: 'assign-1',
      stage: { id: 'stage-9', name: 'Take-home' },
    });

    const result = failed(
      await createStageAction(
        null,
        form({
          applicationId: 'app-1',
          name: 'Assessment',
          type: 'CODING_ASSESSMENT',
          interviewId: 'interview-1',
        }),
      ),
    );

    // A real sentence rather than the P2002 leak from the unique index.
    expect(result.error).toContain('Take-home');
    expect(result.error).not.toMatch(/already taken/i);
    expect(h.db.stage.create).not.toHaveBeenCalled();
  });
});

describe('deleteStageAction', () => {
  it('renumbers the remaining rounds contiguously from zero', async () => {
    h.db.stage.findUnique.mockResolvedValue({
      id: 'stage-2',
      name: 'Technical screen',
      applicationId: 'app-1',
      feedback: [],
    });
    // Whatever their positions were before, what comes back is 0,1,2.
    h.db.stage.findMany.mockResolvedValue([
      { id: 'stage-1' },
      { id: 'stage-3' },
      { id: 'stage-4' },
    ]);

    succeeded(await deleteStageAction(null, form({ id: 'stage-2' })));

    expect(h.db.stage.delete).toHaveBeenCalledWith({ where: { id: 'stage-2' } });
    expect(stageUpdates()).toEqual([
      { where: { id: 'stage-1' }, data: { position: 0 } },
      { where: { id: 'stage-3' }, data: { position: 1 } },
      { where: { id: 'stage-4' }, data: { position: 2 } },
    ]);
    // Delete and renumber go together or not at all.
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain('stage.deleted');
  });

  it('refuses to delete a round that has submitted feedback', async () => {
    h.db.stage.findUnique.mockResolvedValue({
      id: 'stage-2',
      name: 'Technical screen',
      applicationId: 'app-1',
      feedback: [{ id: 'fb-1' }, { id: 'fb-2' }],
    });

    const result = failed(await deleteStageAction(null, form({ id: 'stage-2' })));

    expect(result.error).toMatch(/cannot be removed/i);
    expect(result.error).toMatch(/skip it/i);
    expect(h.db.stage.delete).not.toHaveBeenCalled();
  });
});

describe('reorderStagesAction', () => {
  it('rewrites every position from the submitted order', async () => {
    h.db.stage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    succeeded(await reorderStagesAction({ applicationId: 'app-1', stageIds: ['c', 'a', 'b'] }));

    expect(stageUpdates()).toEqual([
      { where: { id: 'c' }, data: { position: 0 } },
      { where: { id: 'a' }, data: { position: 1 } },
      { where: { id: 'b' }, data: { position: 2 } },
    ]);
  });

  it('rejects a duplicated id rather than writing one stage to two positions', async () => {
    h.db.stage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    // `[a, a]` passes the length check; without the uniqueness refinement it
    // would write `a` twice and never touch `b`.
    const result = failed(
      await reorderStagesAction({ applicationId: 'app-1', stageIds: ['a', 'a'] }),
    );

    expect(result.fieldErrors?.['stageIds']).toEqual(['Stage order contains duplicates.']);
    expect(h.db.stage.update).not.toHaveBeenCalled();
  });

  it('refuses a list that no longer matches the rounds', async () => {
    h.db.stage.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const result = failed(
      await reorderStagesAction({ applicationId: 'app-1', stageIds: ['a', 'b'] }),
    );

    expect(result.error).toMatch(/changed while you were editing/i);
    expect(h.db.stage.update).not.toHaveBeenCalled();
  });
});

describe('setStageStatusAction', () => {
  it('refuses an illegal transition', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow({ status: 'COMPLETE' }));

    const result = failed(
      await setStageStatusAction(null, form({ id: 'stage-2', status: 'PENDING' })),
    );

    expect(result.error).toMatch(/cannot become pending/i);
    expect(h.db.stage.update).not.toHaveBeenCalled();
  });

  it('clears completedAt when a completed round is reopened', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow({ status: 'COMPLETE' }));

    succeeded(
      await setStageStatusAction(null, form({ id: 'stage-2', status: 'AWAITING_FEEDBACK' })),
    );

    const update = h.db.stage.update.mock.calls[0]?.[0] as {
      data: { completedAt: Date | null | undefined };
    };
    expect(update.data.completedAt).toBeNull();
    expect(auditActions()).toContain('stage.status_changed');
  });

  it('refuses to hand-set progress on a coding round', async () => {
    h.db.stage.findUnique.mockResolvedValue(
      stageRow({
        type: 'CODING_ASSESSMENT',
        status: 'PENDING',
        assignment: { status: 'ASSIGNED' },
      }),
    );

    const result = failed(
      await setStageStatusAction(null, form({ id: 'stage-2', status: 'IN_PROGRESS' })),
    );

    expect(result.error).toMatch(/follows the assessment/i);
    expect(h.db.stage.update).not.toHaveBeenCalled();
  });

  it('still lets a person complete a coding round by hand', async () => {
    h.db.stage.findUnique.mockResolvedValue(
      stageRow({
        type: 'CODING_ASSESSMENT',
        status: 'PENDING',
        assignment: { status: 'COMPLETED' },
      }),
    );

    // The derived status is AWAITING_FEEDBACK, so this is a legal move even
    // though the stored status is PENDING — which is the whole point of
    // deriving it rather than reading the row.
    succeeded(await setStageStatusAction(null, form({ id: 'stage-2', status: 'COMPLETE' })));

    expect(h.db.stage.update).toHaveBeenCalledTimes(1);
  });
});

describe('recordStageOutcomeAction', () => {
  it('records the round outcome and leaves the application alone', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow());

    succeeded(await recordStageOutcomeAction(null, form({ id: 'stage-2', outcome: 'REJECT' })));

    expect(h.db.stage.update).toHaveBeenCalledWith({
      where: { id: 'stage-2' },
      data: { outcome: 'REJECT' },
    });
    // The rule this whole feature is built around: a panel's view of one round
    // is not a hiring decision, and nothing here may quietly turn it into one.
    expect(h.db.application.update).not.toHaveBeenCalled();
    expect(h.db.decision.create).not.toHaveBeenCalled();
    expect(h.db.decision.upsert).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(['stage.outcome_recorded']);
  });

  it('does not close the application on an ADVANCE either', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow());

    succeeded(await recordStageOutcomeAction(null, form({ id: 'stage-2', outcome: 'ADVANCE' })));

    expect(h.db.application.update).not.toHaveBeenCalled();
    // Nor does it open the next round on the candidate's behalf.
    expect(h.db.stage.update).toHaveBeenCalledTimes(1);
  });
});

describe('panel membership', () => {
  it('refuses to remove someone who has already submitted feedback', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow());
    h.db.stageInterviewer.findUnique.mockResolvedValue({
      id: 'seat-1',
      user: { name: 'Lena Fischer' },
    });
    h.db.feedback.findFirst.mockResolvedValue({ id: 'fb-1' });

    const result = failed(
      await removePanelistAction(null, form({ stageId: 'stage-2', userId: 'user-9' })),
    );

    expect(result.error).toContain('Lena Fischer');
    expect(result.error).toMatch(/part of the record/i);
    expect(h.db.stageInterviewer.delete).not.toHaveBeenCalled();
  });

  it('removes a panellist who has written nothing', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow());
    h.db.stageInterviewer.findUnique.mockResolvedValue({
      id: 'seat-1',
      user: { name: 'Lena Fischer' },
    });
    h.db.feedback.findFirst.mockResolvedValue(null);

    succeeded(await removePanelistAction(null, form({ stageId: 'stage-2', userId: 'user-9' })));

    expect(h.db.stageInterviewer.delete).toHaveBeenCalledWith({ where: { id: 'seat-1' } });
    expect(auditActions()).toContain('panel.removed');
  });

  it('refuses to seat a candidate on a panel', async () => {
    h.db.stage.findUnique.mockResolvedValue(stageRow());
    h.db.user.findUnique.mockResolvedValue({
      id: 'cand-1',
      name: 'Sample Candidate',
      role: 'CANDIDATE',
      isActive: true,
    });

    const result = failed(
      await addPanelistAction(null, form({ stageId: 'stage-2', userId: 'cand-1' })),
    );

    expect(result.error).toMatch(/only staff who may write feedback/i);
    expect(h.db.stageInterviewer.create).not.toHaveBeenCalled();
  });
});
