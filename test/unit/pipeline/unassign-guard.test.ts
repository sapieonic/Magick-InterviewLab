import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';

/**
 * The seam between an assessment and the round it runs.
 *
 * `unassignInterviewAction` lives in `features/interviews`, but what it can
 * break is a pipeline stage: `Stage.assignmentId` is `ON DELETE SET NULL`, so
 * deleting the assignment silently detaches the round. Nothing on the interview
 * screen shows that, which is why the guard is tested from this side — with the
 * failure it prevents written down next to it.
 */

type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    revalidatePath: vitest.fn(),
    getCurrentUser: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { unassignInterviewAction } from '@/features/interviews/actions';

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

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('unassignInterviewAction and the round it backs', () => {
  it('refuses to unassign an assessment a round is pinned to, and names the round', async () => {
    h.db.stage.findFirst.mockResolvedValue({ name: 'Take-home' });

    const result = failed(
      await unassignInterviewAction(null, form({ candidateId: 'cand-1', interviewId: 'int-1' })),
    );

    expect(result.error).toContain('Take-home');
    expect(result.error).toMatch(/remove that round/i);
    // The whole point: the row survives, so the stage keeps pointing at it and
    // a round submitted days ago does not revert to "pending".
    expect(h.db.interviewAssignment.deleteMany).not.toHaveBeenCalled();
  });

  it('looks the round up through the assignment, not through the stage id', async () => {
    h.db.stage.findFirst.mockResolvedValue(null);
    h.db.interviewAssignment.deleteMany.mockResolvedValue({ count: 1 });

    const result = await unassignInterviewAction(
      null,
      form({ candidateId: 'cand-1', interviewId: 'int-1' }),
    );

    expect(result.ok).toBe(true);
    const where = (h.db.stage.findFirst.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toEqual({
      assignment: { is: { interviewId: 'int-1', candidateId: 'cand-1' } },
    });
  });

  it('still unassigns an assessment no round is using', async () => {
    h.db.stage.findFirst.mockResolvedValue(null);
    h.db.interviewAssignment.deleteMany.mockResolvedValue({ count: 1 });

    const result = await unassignInterviewAction(
      null,
      form({ candidateId: 'cand-1', interviewId: 'int-1' }),
    );

    expect(result.ok).toBe(true);
    expect(h.db.interviewAssignment.deleteMany).toHaveBeenCalledWith({
      where: { interviewId: 'int-1', candidateId: 'cand-1' },
    });
  });

  it('checks the round before it checks that the assignment exists', async () => {
    // Otherwise a missing-assignment message would be the one a recruiter sees
    // for the case the guard is actually about.
    h.db.stage.findFirst.mockResolvedValue({ name: 'Take-home' });
    h.db.interviewAssignment.deleteMany.mockResolvedValue({ count: 0 });

    const result = failed(
      await unassignInterviewAction(null, form({ candidateId: 'cand-1', interviewId: 'int-1' })),
    );

    expect(result.error).toContain('Take-home');
  });
});
