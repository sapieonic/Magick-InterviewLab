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
  requireAdmin,
  requireAdminPage,
  requireCandidate,
  requireCandidatePage,
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
