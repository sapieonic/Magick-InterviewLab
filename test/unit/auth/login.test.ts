import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MockRedirectError } from '../../helpers/next-mocks';
import type { ActionResult } from '@/lib/action-result';

/** The failure branch of the discriminated union, so `.error` is reachable. */
type ActionFailure = Extract<ActionResult<never>, { ok: false }>;

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { createHeaderStore, mockRedirect } = await import('../../helpers/next-mocks');
  const { vi: vitest } = await import('vitest');
  return {
    db: createPrismaMock(),
    headers: createHeaderStore({ 'user-agent': 'Vitest/1.0' }),
    redirect: vitest.fn(mockRedirect),
    createSession: vitest.fn(),
    destroySession: vitest.fn(),
    destroyAllSessionsFor: vitest.fn(),
    getCurrentUser: vitest.fn(),
    verifyPassword: vitest.fn(),
    hashPassword: vitest.fn(),
    ensureBootstrapAdmin: vitest.fn(),
  };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(h.headers) }));
vi.mock('@/features/auth/session', () => ({
  createSession: h.createSession,
  destroySession: h.destroySession,
  destroyAllSessionsFor: h.destroyAllSessionsFor,
  getCurrentUser: h.getCurrentUser,
}));
vi.mock('@/features/auth/password', () => ({
  verifyPassword: h.verifyPassword,
  hashPassword: h.hashPassword,
  isArgon2Hash: () => true,
}));
// Login opportunistically bootstraps the admin; that is a separate concern and
// would otherwise pull `serverEnv()` and more database calls into every case.
vi.mock('@/features/auth/bootstrap', () => ({ ensureBootstrapAdmin: h.ensureBootstrapAdmin }));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import { loginAction } from '@/features/auth/actions';

interface StoredUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'ADMIN' | 'CANDIDATE';
  isActive: boolean;
  mustChangePassword: boolean;
}

function storedUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    role: 'CANDIDATE',
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

/** On success the action redirects, which surfaces as a thrown digest error. */
async function loginExpectingRedirect(fields: Record<string, string>): Promise<string> {
  try {
    await loginAction(null, form(fields));
  } catch (error) {
    if (error instanceof MockRedirectError) return error.url;
    throw error;
  }
  throw new Error('expected loginAction to redirect');
}

async function loginExpectingFailure(fields: Record<string, string>): Promise<ActionFailure> {
  const result = await loginAction(null, form(fields));
  if (result === null || result.ok) throw new Error('expected loginAction to fail');
  return result;
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.redirect.mockClear();
  h.createSession.mockReset();
  h.verifyPassword.mockReset();
  h.ensureBootstrapAdmin.mockReset();
  h.ensureBootstrapAdmin.mockResolvedValue({ created: false });
});

describe('loginAction — user enumeration', () => {
  it('reports the generic failure for a wrong password', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser());
    h.verifyPassword.mockResolvedValue(false);

    const result = await loginExpectingFailure({ email: 'ada@example.com', password: 'nope1234' });

    expect(result.error).toBe('Incorrect email or password.');
  });

  /**
   * The security property under test: an attacker must not be able to tell a
   * registered address from an unregistered one. Both the message and the
   * amount of work done have to match, so the action verifies against a dummy
   * Argon2 digest when the account does not exist.
   */
  it('reports the identical message for an unknown email, and still spends a verify', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser());
    h.verifyPassword.mockResolvedValue(false);
    const wrongPassword = await loginExpectingFailure({
      email: 'ada@example.com',
      password: 'nope1234',
    });

    resetPrismaMock(h.db);
    h.verifyPassword.mockClear();
    h.db.user.findUnique.mockResolvedValue(null);
    const unknownEmail = await loginExpectingFailure({
      email: 'nobody@example.com',
      password: 'nope1234',
    });

    expect(unknownEmail.error).toBe(wrongPassword.error);
    expect(h.verifyPassword).toHaveBeenCalledTimes(1);
    const [digest] = h.verifyPassword.mock.calls[0] as [string, string];
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  // Checked after the password so "this account is inactive" cannot be used to
  // probe which addresses are registered.
  it('does not reveal an inactive account to someone with the wrong password', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser({ isActive: false }));
    h.verifyPassword.mockResolvedValue(false);

    const result = await loginExpectingFailure({ email: 'ada@example.com', password: 'nope1234' });

    expect(result.error).toBe('Incorrect email or password.');
  });

  it('rejects a malformed email with the generic message rather than a validation error', async () => {
    const result = await loginExpectingFailure({ email: 'not-an-email', password: 'whatever1' });

    expect(result.error).toBe('Incorrect email or password.');
    expect(h.db.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('loginAction — inactive account', () => {
  it('refuses an inactive user who supplied the right password, and creates no session', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser({ isActive: false }));
    h.verifyPassword.mockResolvedValue(true);

    const result = await loginExpectingFailure({ email: 'ada@example.com', password: 'right1234' });

    expect(result.error).toBe('This account is inactive. Contact your administrator.');
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.db.user.update).not.toHaveBeenCalled();
  });
});

describe('loginAction — success', () => {
  it('creates a session, stamps lastLoginAt and lands the candidate in the workspace', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser());
    h.db.user.update.mockResolvedValue(storedUser());
    h.verifyPassword.mockResolvedValue(true);

    const destination = await loginExpectingRedirect({
      email: 'ada@example.com',
      password: 'right1234',
    });

    expect(destination).toBe('/interview');
    expect(h.createSession).toHaveBeenCalledWith('user-1', 'Vitest/1.0');
    const update = h.db.user.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { lastLoginAt: Date };
    };
    expect(update.where.id).toBe('user-1');
    expect(update.data.lastLoginAt).toBeInstanceOf(Date);
  });

  it('lands an admin in the admin area', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser({ role: 'ADMIN' }));
    h.db.user.update.mockResolvedValue(storedUser({ role: 'ADMIN' }));
    h.verifyPassword.mockResolvedValue(true);

    await expect(
      loginExpectingRedirect({ email: 'ada@example.com', password: 'right1234' }),
    ).resolves.toBe('/admin');
  });

  it('sends a user with a temporary password to change it before anything else', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser({ mustChangePassword: true }));
    h.db.user.update.mockResolvedValue(storedUser({ mustChangePassword: true }));
    h.verifyPassword.mockResolvedValue(true);

    await expect(
      loginExpectingRedirect({ email: 'ada@example.com', password: 'right1234' }),
    ).resolves.toBe('/change-password');
  });

  it('normalises the email before looking the account up', async () => {
    h.db.user.findUnique.mockResolvedValue(storedUser());
    h.db.user.update.mockResolvedValue(storedUser());
    h.verifyPassword.mockResolvedValue(true);

    await loginExpectingRedirect({ email: '  Ada@Example.COM  ', password: 'right1234' });

    expect(h.db.user.findUnique).toHaveBeenCalledWith({ where: { email: 'ada@example.com' } });
  });
});

/**
 * Open-redirect protection. `next` arrives from the query string, so anything
 * that is not a same-origin absolute path must be discarded in favour of the
 * role's home — otherwise the login page becomes a redirector an attacker can
 * point at their own domain from a link that looks like ours.
 */
describe('loginAction — next= redirect safety', () => {
  beforeEach(() => {
    h.db.user.findUnique.mockResolvedValue(storedUser({ role: 'ADMIN' }));
    h.db.user.update.mockResolvedValue(storedUser({ role: 'ADMIN' }));
    h.verifyPassword.mockResolvedValue(true);
  });

  it('honours a same-origin absolute path', async () => {
    await expect(
      loginExpectingRedirect({
        email: 'ada@example.com',
        password: 'right1234',
        next: '/admin/candidates?page=2',
      }),
    ).resolves.toBe('/admin/candidates?page=2');
  });

  it.each([
    ['a protocol-relative URL', '//evil.com'],
    ['a protocol-relative URL with a path', '//evil.com/admin'],
    ['an absolute https URL', 'https://evil.com'],
    ['an absolute http URL', 'http://evil.com/admin'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare relative path', 'admin/candidates'],
    ['an empty value', ''],
  ])('ignores %s and falls back to the role home', async (_label, next) => {
    await expect(
      loginExpectingRedirect({ email: 'ada@example.com', password: 'right1234', next }),
    ).resolves.toBe('/admin');
  });
});
