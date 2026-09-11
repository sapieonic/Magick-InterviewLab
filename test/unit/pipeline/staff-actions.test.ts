import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionResult } from '@/lib/action-result';
import type { SessionUser } from '@/features/auth/session';

type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    revalidatePath: vitest.fn(),
    getCurrentUser: vitest.fn(),
    destroyAllSessionsFor: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/features/auth/session', () => ({
  getCurrentUser: h.getCurrentUser,
  destroyAllSessionsFor: h.destroyAllSessionsFor,
}));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { setStaffActiveAction, setUserRoleAction } from '@/features/staff/actions';

function actor(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'admin-1',
    name: 'Root',
    email: 'root@example.com',
    role: 'ADMIN',
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
  h.destroyAllSessionsFor.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

describe('setUserRoleAction', () => {
  it('refuses to change your own role', async () => {
    const result = failed(
      await setUserRoleAction(null, form({ id: 'admin-1', role: 'RECRUITER' })),
    );

    expect(result.error).toMatch(/your own role/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
    // The check runs before the lookup: there is nothing to read, because the
    // answer does not depend on the target row.
    expect(h.db.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to promote a candidate into staff', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'cand-1', role: 'CANDIDATE', name: 'Ada' });

    const result = failed(
      await setUserRoleAction(null, form({ id: 'cand-1', role: 'INTERVIEWER' })),
    );

    expect(result.error).toContain('Ada');
    expect(result.error).toMatch(/separate staff account/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
  });

  it('refuses to demote staff into a candidate', async () => {
    // `staffRoleSchema` is the guard here — CANDIDATE is not one of its values,
    // so the payload never reaches the database at all.
    const result = failed(await setUserRoleAction(null, form({ id: 'int-1', role: 'CANDIDATE' })));

    expect(result.fieldErrors?.['role']).toBeTruthy();
    expect(h.db.user.update).not.toHaveBeenCalled();
  });

  it('changes another staff member and signs their sessions out', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'int-1', role: 'INTERVIEWER', name: 'Lena' });

    const result = await setUserRoleAction(null, form({ id: 'int-1', role: 'RECRUITER' }));

    expect(result.ok).toBe(true);
    expect(h.db.user.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { role: 'RECRUITER' },
    });
    expect(h.destroyAllSessionsFor).toHaveBeenCalledWith('int-1');
  });

  it('refuses a non-admin outright', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'rec-1', role: 'RECRUITER' }));

    const result = failed(await setUserRoleAction(null, form({ id: 'int-1', role: 'ADMIN' })));

    expect(result.error).toMatch(/permission/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
  });
});

/**
 * Deactivation, now that the settings table actually offers it. Same lockout
 * reasoning as a self-demotion: the capability that could undo it is the one
 * being taken away.
 */
describe('setStaffActiveAction', () => {
  it('refuses to deactivate your own account', async () => {
    const result = failed(
      await setStaffActiveAction(null, form({ id: 'admin-1', isActive: 'false' })),
    );

    expect(result.error).toMatch(/your own account/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
  });

  it('deactivates a colleague and signs their sessions out', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'int-1', role: 'INTERVIEWER', name: 'Lena' });

    const result = await setStaffActiveAction(null, form({ id: 'int-1', isActive: 'false' }));

    expect(result.ok).toBe(true);
    expect(h.db.user.update).toHaveBeenCalledWith({
      where: { id: 'int-1' },
      data: { isActive: false },
    });
    expect(h.destroyAllSessionsFor).toHaveBeenCalledWith('int-1');
  });

  it('reactivates without touching sessions', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'int-1', role: 'INTERVIEWER', name: 'Lena' });

    const result = await setStaffActiveAction(null, form({ id: 'int-1', isActive: 'true' }));

    expect(result.ok).toBe(true);
    // Nothing to destroy: they could not sign in while deactivated, so there
    // is no old session to resurrect.
    expect(h.destroyAllSessionsFor).not.toHaveBeenCalled();
  });

  it('sends an admin to the candidates screen for a candidate account', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'cand-1', role: 'CANDIDATE', name: 'Ada' });

    const result = failed(
      await setStaffActiveAction(null, form({ id: 'cand-1', isActive: 'false' })),
    );

    expect(result.error).toContain('Ada');
    expect(result.error).toMatch(/candidates screen/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a non-admin outright', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'rec-1', role: 'RECRUITER' }));

    const result = failed(
      await setStaffActiveAction(null, form({ id: 'int-1', isActive: 'false' })),
    );

    expect(result.error).toMatch(/permission/i);
    expect(h.db.user.update).not.toHaveBeenCalled();
  });
});
