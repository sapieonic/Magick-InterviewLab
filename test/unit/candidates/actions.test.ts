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
    destroyAllSessionsFor: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
// Only the session lookup is faked: `requireAdmin` itself is the control
// under test here, so the real guard (and the real error it throws, which
// `actionGuard` matches on by identity) stays in the path.
vi.mock('@/features/auth/session', () => ({
  getCurrentUser: h.getCurrentUser,
  destroyAllSessionsFor: h.destroyAllSessionsFor,
}));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  createCandidateAction,
  resetCandidatePasswordAction,
  setCandidateActiveAction,
  updateCandidateAction,
} from '@/features/candidates/actions';

const VALID_PASSWORD = 'Temp0rary1';

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

/** The `data` argument of the single `prisma.user.create` call. */
function createdUserData(): Record<string, unknown> {
  const call = h.db.user.create.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected prisma.user.create to have been called');
  return call.data;
}

function updatedUserData(): Record<string, unknown> {
  const call = h.db.user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
  if (!call) throw new Error('expected prisma.user.update to have been called');
  return call.data;
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.revalidatePath.mockReset();
  h.getCurrentUser.mockReset();
  h.destroyAllSessionsFor.mockReset();
  h.getCurrentUser.mockResolvedValue(actor());
});

/**
 * Authorization is the first thing every candidate action does. The assertion
 * that matters is not the message but that nothing reached the database: a
 * guard that runs *after* the write is not a guard.
 */
describe('candidate actions — authorization', () => {
  it('refuses a candidate actor and writes no user row', async () => {
    h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));

    const result = failed(
      await createCandidateAction(
        null,
        form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
      ),
    );

    expect(result.error).toBe('You do not have permission to perform this action.');
    expect(h.db.user.create).not.toHaveBeenCalled();
    expect(h.db.user.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller and writes no user row', async () => {
    h.getCurrentUser.mockResolvedValue(null);

    const result = failed(
      await createCandidateAction(
        null,
        form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
      ),
    );

    expect(result.error).toBe('Your session has expired. Please sign in again.');
    expect(h.db.user.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'resetCandidatePasswordAction',
      resetCandidatePasswordAction,
      { temporaryPassword: VALID_PASSWORD },
    ],
    ['setCandidateActiveAction', setCandidateActiveAction, { isActive: 'false' }],
    ['updateCandidateAction', updateCandidateAction, { name: 'Ada', email: 'ada@example.com' }],
  ])(
    'refuses a candidate actor calling %s, touching neither the row nor its sessions',
    async (_label, action, extra) => {
      h.getCurrentUser.mockResolvedValue(actor({ id: 'cand-1', role: 'CANDIDATE' }));

      const result = failed(await action(null, form({ id: 'cand-2', ...extra })));

      expect(result.error).toBe('You do not have permission to perform this action.');
      expect(h.db.user.update).not.toHaveBeenCalled();
      expect(h.destroyAllSessionsFor).not.toHaveBeenCalled();
    },
  );
});

describe('createCandidateAction', () => {
  beforeEach(() => {
    h.db.user.findUnique.mockResolvedValue(null);
    h.db.user.create.mockResolvedValue({ id: 'cand-1', name: 'Ada', email: 'ada@example.com' });
  });

  /**
   * The plaintext must never reach a column. Asserting against a real Argon2
   * digest rather than a stubbed `hashPassword` means a future refactor that
   * drops the call — or stores the plaintext alongside it — fails here.
   */
  it('stores an Argon2id digest and never the plaintext password', async () => {
    const result = await createCandidateAction(
      null,
      form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
    );

    expect(result.ok).toBe(true);
    const data = createdUserData();
    expect(data.passwordHash).not.toBe(VALID_PASSWORD);
    expect(String(data.passwordHash).startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(data)).not.toContain(VALID_PASSWORD);
  });

  // An admin picked the password, so the admin knows it: it is temporary by
  // construction and the candidate has to replace it before doing anything.
  it('marks the new account as needing a password change', async () => {
    await createCandidateAction(
      null,
      form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
    );

    expect(createdUserData().mustChangePassword).toBe(true);
    expect(createdUserData().role).toBe('CANDIDATE');
  });

  it('normalises the email before both the duplicate check and the insert', async () => {
    await createCandidateAction(
      null,
      form({ name: '  Ada  ', email: '  Ada@Example.COM  ', temporaryPassword: VALID_PASSWORD }),
    );

    expect(h.db.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
      select: { id: true },
    });
    expect(createdUserData().email).toBe('ada@example.com');
    expect(createdUserData().name).toBe('Ada');
  });

  /**
   * The unique index would also stop this, but only as a P2002 the admin sees
   * as "That value is already taken." The pre-check exists so the message
   * names the field, and it must run before any write.
   */
  it('reports a duplicate email as a field error rather than letting Prisma raise', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'existing-1' });

    const result = failed(
      await createCandidateAction(
        null,
        form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
      ),
    );

    expect(result.error).toBe('A user with that email already exists.');
    expect(result.fieldErrors?.email).toEqual(['A user with that email already exists.']);
    expect(h.db.user.create).not.toHaveBeenCalled();
  });

  it('creates the assignment in the same write when an interview is chosen', async () => {
    h.db.interview.findUnique.mockResolvedValue({ id: 'int-1' });

    await createCandidateAction(
      null,
      form({
        name: 'Ada',
        email: 'ada@example.com',
        temporaryPassword: VALID_PASSWORD,
        interviewId: 'int-1',
      }),
    );

    expect(createdUserData().assignments).toEqual({ create: { interviewId: 'int-1' } });
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/interviews/int-1');
  });

  it('leaves the interview unassigned when the field is blank, without looking one up', async () => {
    await createCandidateAction(
      null,
      form({
        name: 'Ada',
        email: 'ada@example.com',
        temporaryPassword: VALID_PASSWORD,
        interviewId: '   ',
      }),
    );

    expect(h.db.interview.findUnique).not.toHaveBeenCalled();
    expect(createdUserData()).not.toHaveProperty('assignments');
  });

  it('refuses an interview id that no longer exists, and writes nothing', async () => {
    h.db.interview.findUnique.mockResolvedValue(null);

    const result = failed(
      await createCandidateAction(
        null,
        form({
          name: 'Ada',
          email: 'ada@example.com',
          temporaryPassword: VALID_PASSWORD,
          interviewId: 'gone',
        }),
      ),
    );

    expect(result.error).toBe('That interview no longer exists.');
    expect(h.db.user.create).not.toHaveBeenCalled();
  });

  it('rejects a temporary password that fails the policy before touching the database', async () => {
    const result = failed(
      await createCandidateAction(
        null,
        form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: 'short' }),
      ),
    );

    expect(result.fieldErrors?.temporaryPassword).toBeDefined();
    expect(h.db.user.findUnique).not.toHaveBeenCalled();
    expect(h.db.user.create).not.toHaveBeenCalled();
  });
});

/**
 * The candidate screens must not reach an admin row. Every one of these
 * actions sets `mustChangePassword`, revokes sessions or flips `isActive` —
 * run against a colleague's console account that is a lockout, and the UI
 * that hides the button is presentation, not a control.
 */
describe('candidate actions — the ADMIN-row guard', () => {
  const adminTarget = { id: 'admin-2' };

  beforeEach(() => {
    // `requireCandidateRecord` filters on `role: 'CANDIDATE'`, so an admin id
    // simply finds nothing.
    h.db.user.findFirst.mockResolvedValue(null);
  });

  it.each([
    [
      'resetCandidatePasswordAction',
      resetCandidatePasswordAction,
      { temporaryPassword: VALID_PASSWORD },
    ],
    ['setCandidateActiveAction', setCandidateActiveAction, { isActive: 'false' }],
    ['updateCandidateAction', updateCandidateAction, { name: 'Root', email: 'root@example.com' }],
  ])(
    '%s refuses a row that is not a candidate, and neither writes nor revokes',
    async (_label, action, extra) => {
      const result = failed(await action(null, form({ id: adminTarget.id, ...extra })));

      expect(result.error).toBe('Candidate not found.');
      expect(h.db.user.update).not.toHaveBeenCalled();
      expect(h.destroyAllSessionsFor).not.toHaveBeenCalled();
    },
  );

  it('scopes the lookup by role rather than filtering after the read', async () => {
    await resetCandidatePasswordAction(
      null,
      form({ id: adminTarget.id, temporaryPassword: VALID_PASSWORD }),
    );

    expect(h.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: adminTarget.id, role: 'CANDIDATE' },
      select: { id: true, email: true },
    });
  });
});

describe('resetCandidatePasswordAction', () => {
  beforeEach(() => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1', email: 'ada@example.com' });
    h.db.user.update.mockResolvedValue({ id: 'cand-1' });
  });

  /**
   * The security property: a reset exists because the old credential is
   * suspect, so a session minted under it has to die with it. Re-flagging
   * `mustChangePassword` without revoking would leave an attacker's cookie
   * working against a password the admin believes they have changed.
   */
  it('revokes every live session as well as forcing a password change', async () => {
    const result = await resetCandidatePasswordAction(
      null,
      form({ id: 'cand-1', temporaryPassword: VALID_PASSWORD }),
    );

    expect(result.ok).toBe(true);
    expect(updatedUserData().mustChangePassword).toBe(true);
    expect(String(updatedUserData().passwordHash).startsWith('$argon2id$')).toBe(true);
    expect(h.destroyAllSessionsFor).toHaveBeenCalledWith('cand-1');
  });

  it('stores a digest, never the plaintext the admin typed', async () => {
    await resetCandidatePasswordAction(
      null,
      form({ id: 'cand-1', temporaryPassword: VALID_PASSWORD }),
    );

    expect(JSON.stringify(updatedUserData())).not.toContain(VALID_PASSWORD);
  });
});

describe('setCandidateActiveAction', () => {
  beforeEach(() => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1', email: 'ada@example.com' });
    h.db.user.update.mockResolvedValue({ id: 'cand-1' });
  });

  // Deleting the rows means a later re-activation cannot silently resurrect
  // a session that was live at the moment of suspension.
  it('destroys sessions when deactivating', async () => {
    const result = await setCandidateActiveAction(null, form({ id: 'cand-1', isActive: 'false' }));

    expect(result.ok).toBe(true);
    expect(updatedUserData()).toEqual({ isActive: false });
    expect(h.destroyAllSessionsFor).toHaveBeenCalledWith('cand-1');
  });

  it('leaves sessions alone when re-activating', async () => {
    const result = await setCandidateActiveAction(null, form({ id: 'cand-1', isActive: 'true' }));

    expect(result.ok).toBe(true);
    expect(updatedUserData()).toEqual({ isActive: true });
    expect(h.destroyAllSessionsFor).not.toHaveBeenCalled();
  });
});

describe('updateCandidateAction', () => {
  beforeEach(() => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1', email: 'ada@example.com' });
    h.db.user.update.mockResolvedValue({ id: 'cand-1' });
  });

  it('allows a candidate to keep their own email', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'cand-1' });

    const result = await updateCandidateAction(
      null,
      form({ id: 'cand-1', name: 'Ada L', email: 'ada@example.com' }),
    );

    expect(result.ok).toBe(true);
    expect(updatedUserData()).toEqual({ name: 'Ada L', email: 'ada@example.com' });
  });

  it('refuses an email already held by someone else', async () => {
    h.db.user.findUnique.mockResolvedValue({ id: 'other-1' });

    const result = failed(
      await updateCandidateAction(
        null,
        form({ id: 'cand-1', name: 'Ada', email: 'taken@example.com' }),
      ),
    );

    expect(result.error).toBe('A user with that email already exists.');
    expect(h.db.user.update).not.toHaveBeenCalled();
  });
});

/**
 * A password hash reaching an action result would travel on into the RSC
 * payload and anything that logs a failed action. The control is the explicit
 * `select`, so that is what is pinned — not just the shape of the mock's
 * return value, which a test could otherwise satisfy by accident.
 */
describe('candidate actions — no hash ever leaves the server', () => {
  it('selects only id/name/email when creating, and returns nothing else', async () => {
    h.db.user.findUnique.mockResolvedValue(null);
    h.db.user.create.mockResolvedValue({ id: 'cand-1', name: 'Ada', email: 'ada@example.com' });

    const result = await createCandidateAction(
      null,
      form({ name: 'Ada', email: 'ada@example.com', temporaryPassword: VALID_PASSWORD }),
    );

    const call = h.db.user.create.mock.calls[0]?.[0] as { select: Record<string, boolean> };
    expect(Object.keys(call.select).sort()).toEqual(['email', 'id', 'name']);
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('$argon2');
  });

  it('returns no data at all from reset, activate and update', async () => {
    h.db.user.findFirst.mockResolvedValue({ id: 'cand-1', email: 'ada@example.com' });
    h.db.user.update.mockResolvedValue({ id: 'cand-1', passwordHash: '$argon2id$leaked' });
    h.db.user.findUnique.mockResolvedValue(null);

    const results = [
      await resetCandidatePasswordAction(
        null,
        form({ id: 'cand-1', temporaryPassword: VALID_PASSWORD }),
      ),
      await setCandidateActiveAction(null, form({ id: 'cand-1', isActive: 'true' })),
      await updateCandidateAction(
        null,
        form({ id: 'cand-1', name: 'Ada', email: 'ada@example.com' }),
      ),
    ];

    for (const result of results) {
      expect(result).toEqual({ ok: true, data: undefined });
      expect(JSON.stringify(result)).not.toContain('$argon2');
    }
  });
});
