import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MockRedirectError } from '../../helpers/next-mocks';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { mockRedirect } = await import('../../helpers/next-mocks');
  const { vi: vitest } = await import('vitest');
  return {
    getCurrentUser: vitest.fn(),
    redirect: vitest.fn(mockRedirect),
  };
});

vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('@/features/auth/session', () => ({ getCurrentUser: h.getCurrentUser }));

import {
  AuthenticationError,
  AuthorizationError,
  homePathFor,
  PasswordChangeRequiredError,
  requireAdmin,
  requireAdminPage,
  requireCandidate,
  requireCandidatePage,
  requireCapability,
  requireCapabilityPage,
  requireStaff,
  requireStaffPage,
  requireUser,
} from '@/features/auth/guards';
import type { SessionUser } from '@/features/auth/session';

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'CANDIDATE',
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  };
}

const admin = user({ id: 'admin-1', role: 'ADMIN' });
const candidate = user({ id: 'cand-1', role: 'CANDIDATE' });

/** The page guards signal by throwing a NEXT_REDIRECT-shaped error. */
async function redirectedTo(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof MockRedirectError) return error.url;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  h.getCurrentUser.mockReset();
  h.redirect.mockClear();
});

describe('requireUser', () => {
  it('throws AuthenticationError when signed out', async () => {
    h.getCurrentUser.mockResolvedValue(null);
    await expect(requireUser()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('returns the signed-in user', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(requireUser()).resolves.toEqual(candidate);
  });
});

describe('requireAdmin', () => {
  it('returns the user for an admin', async () => {
    h.getCurrentUser.mockResolvedValue(admin);
    await expect(requireAdmin()).resolves.toEqual(admin);
  });

  // Authorization is enforced server-side on every mutation: a candidate who
  // calls an admin action directly must be refused, not merely un-navigated.
  it('throws AuthorizationError for a candidate', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('throws AuthenticationError when signed out', async () => {
    h.getCurrentUser.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AuthenticationError);
  });

  // A seeded admin holds a temporary password. The page guard redirects them to
  // /change-password, but a Server Action is reachable without a page, so the
  // action guard must refuse an admin mutation until the password is rotated.
  it('throws PasswordChangeRequiredError for an admin who must change their password', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'ADMIN', mustChangePassword: true }));
    await expect(requireAdmin()).rejects.toBeInstanceOf(PasswordChangeRequiredError);
  });
});

describe('requireCandidate', () => {
  it('returns the user for a candidate', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(requireCandidate()).resolves.toEqual(candidate);
  });

  it('throws AuthorizationError for an admin', async () => {
    h.getCurrentUser.mockResolvedValue(admin);
    await expect(requireCandidate()).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('throws AuthenticationError when signed out', async () => {
    h.getCurrentUser.mockResolvedValue(null);
    await expect(requireCandidate()).rejects.toBeInstanceOf(AuthenticationError);
  });

  // Same reasoning as requireAdmin: saveDraft / createSubmission must be
  // blocked until the admin-chosen temporary password has been changed.
  it('throws PasswordChangeRequiredError for a candidate who must change their password', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'CANDIDATE', mustChangePassword: true }));
    await expect(requireCandidate()).rejects.toBeInstanceOf(PasswordChangeRequiredError);
  });

  // requireUser stays permissive: changePasswordAction and logout run through
  // it, and a must-change user has to be able to reach exactly those.
  it('requireUser does NOT block a user who must change their password', async () => {
    const pending = user({ mustChangePassword: true });
    h.getCurrentUser.mockResolvedValue(pending);
    await expect(requireUser()).resolves.toEqual(pending);
  });
});

describe('page guards', () => {
  it('sends a signed-out visitor to login with a next= back to the admin area', async () => {
    h.getCurrentUser.mockResolvedValue(null);
    await expect(redirectedTo(requireAdminPage)).resolves.toBe('/login?next=/admin');
  });

  it('sends a candidate away from the admin area to their own workspace', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(redirectedTo(requireAdminPage)).resolves.toBe('/interview');
  });

  it('sends a signed-out visitor to login with a next= back to the interview', async () => {
    h.getCurrentUser.mockResolvedValue(null);
    await expect(redirectedTo(requireCandidatePage)).resolves.toBe('/login?next=/interview');
  });

  it('sends an admin away from the interview workspace to the admin area', async () => {
    h.getCurrentUser.mockResolvedValue(admin);
    await expect(redirectedTo(requireCandidatePage)).resolves.toBe('/admin');
  });

  // A candidate with a temporary password must not reach the workspace before
  // rotating it, or the admin-chosen password stays valid indefinitely.
  it('forces a candidate with a temporary password to change it first', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'CANDIDATE', mustChangePassword: true }));
    await expect(redirectedTo(requireCandidatePage)).resolves.toBe('/change-password');
  });

  // A seeded admin is created with a temporary password too; the console must
  // not be usable until it is rotated.
  it('forces an admin with a temporary password to change it first', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'ADMIN', mustChangePassword: true }));
    await expect(redirectedTo(requireAdminPage)).resolves.toBe('/change-password');
  });

  it('lets an admin through the admin guard without redirecting', async () => {
    h.getCurrentUser.mockResolvedValue(admin);
    await expect(requireAdminPage()).resolves.toEqual(admin);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  it('lets a settled candidate through the candidate guard without redirecting', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(requireCandidatePage()).resolves.toEqual(candidate);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe('homePathFor', () => {
  it('routes an admin to the admin area', () => {
    expect(homePathFor({ role: 'ADMIN', mustChangePassword: false })).toBe('/admin');
  });

  it('routes a candidate to the interview workspace', () => {
    expect(homePathFor({ role: 'CANDIDATE', mustChangePassword: false })).toBe('/interview');
  });

  // The password gate wins over the role, for both roles.
  it('routes anyone who must change their password to the change-password page', () => {
    expect(homePathFor({ role: 'ADMIN', mustChangePassword: true })).toBe('/change-password');
    expect(homePathFor({ role: 'CANDIDATE', mustChangePassword: true })).toBe('/change-password');
  });
});

describe('capability guards', () => {
  const recruiter = user({ id: 'rec-1', role: 'RECRUITER' });
  const interviewer = user({ id: 'int-1', role: 'INTERVIEWER' });
  const hiringManager = user({ id: 'hm-1', role: 'HIRING_MANAGER' });

  it('admits a holder of the capability', async () => {
    h.getCurrentUser.mockResolvedValue(recruiter);
    await expect(requireCapability('MANAGE_PIPELINE')).resolves.toEqual(recruiter);
  });

  it('refuses someone who lacks it, whatever else they may do', async () => {
    h.getCurrentUser.mockResolvedValue(recruiter);
    await expect(requireCapability('DECIDE')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('still forces a temporary password to be rotated first', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'RECRUITER', mustChangePassword: true }));
    await expect(requireCapability('MANAGE_PIPELINE')).rejects.toBeInstanceOf(
      PasswordChangeRequiredError,
    );
  });

  // requireAdmin now asks for a capability rather than comparing roles. The
  // behaviour it guarded must not have widened: only an admin still passes.
  it('keeps requireAdmin admin-only across every new staff role', async () => {
    for (const staff of [recruiter, interviewer, hiringManager]) {
      h.getCurrentUser.mockResolvedValue(staff);
      await expect(requireAdmin()).rejects.toBeInstanceOf(AuthorizationError);
    }
    h.getCurrentUser.mockResolvedValue(admin);
    await expect(requireAdmin()).resolves.toEqual(admin);
  });

  it('admits every staff role to the console and refuses a candidate', async () => {
    for (const staff of [admin, recruiter, interviewer, hiringManager]) {
      h.getCurrentUser.mockResolvedValue(staff);
      await expect(requireStaff()).resolves.toEqual(staff);
    }
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(requireStaff()).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe('capability page guards', () => {
  const interviewer = user({ id: 'int-1', role: 'INTERVIEWER' });

  it('lets a staff member through a page their role covers', async () => {
    h.getCurrentUser.mockResolvedValue(interviewer);
    await expect(requireStaffPage()).resolves.toEqual(interviewer);
    expect(h.redirect).not.toHaveBeenCalled();
  });

  // A staff member who lacks the capability goes to the console home, not to
  // /interview: they are not a candidate, and dropping an interviewer into a
  // candidate workspace is a confusing dead end.
  it('sends a staff member without the capability to the console home', async () => {
    h.getCurrentUser.mockResolvedValue(interviewer);
    await expect(redirectedTo(() => requireCapabilityPage('MANAGE_CONTENT'))).resolves.toBe(
      '/admin',
    );
  });

  it('still sends a candidate to their own workspace', async () => {
    h.getCurrentUser.mockResolvedValue(candidate);
    await expect(redirectedTo(requireStaffPage)).resolves.toBe('/interview');
  });

  // The password gate must be checked before the capability check, or a staff
  // member with a temporary password bounces to /admin and never rotates it.
  it('forces a password rotation ahead of the capability check', async () => {
    h.getCurrentUser.mockResolvedValue(user({ role: 'INTERVIEWER', mustChangePassword: true }));
    await expect(redirectedTo(() => requireCapabilityPage('MANAGE_CONTENT'))).resolves.toBe(
      '/change-password',
    );
  });
});

describe('homePathFor with the new staff roles', () => {
  it('routes every staff role to the console', () => {
    for (const role of ['ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'] as const) {
      expect(homePathFor({ role, mustChangePassword: false })).toBe('/admin');
    }
  });
});
