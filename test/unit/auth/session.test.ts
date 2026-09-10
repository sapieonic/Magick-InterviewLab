import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RecordedCookie } from '../../helpers/next-mocks';

vi.mock('server-only', () => ({}));

/**
 * The mock instances are built inside `vi.hoisted` so the *same* objects
 * survive the `vi.resetModules()` the cookie-flag tests need — a factory that
 * built a fresh mock on re-import would leave the assertions holding a stale
 * reference.
 */
const h = await vi.hoisted(async () => {
  const { createPrismaMock } = await import('../../helpers/prisma-mock');
  const { createCookieStore } = await import('../../helpers/next-mocks');
  return { db: createPrismaMock(), cookies: createCookieStore() };
});

vi.mock('@/lib/db/prisma', () => ({ prisma: h.db }));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(h.cookies),
  headers: () => Promise.resolve({ get: () => null }),
}));

import { resetPrismaMock } from '../../helpers/prisma-mock';
import {
  SESSION_COOKIE,
  constantTimeEquals,
  createSession,
  destroyAllSessionsFor,
  destroySession,
  getCurrentUser,
  purgeExpiredSessions,
} from '@/features/auth/session';

// `serverEnv()` validates the whole process environment on first use. Vitest
// does not load `.env`, so the suite states exactly what it depends on.
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
process.env.SESSION_TTL_HOURS = '6';
delete process.env.COOKIE_SECURE;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function lastSet(): RecordedCookie {
  const set = h.cookies.sets.at(-1);
  if (!set) throw new Error('expected a cookie to have been set');
  return set;
}

function activeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'ADMIN',
    isActive: true,
    mustChangePassword: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(h.db);
  h.cookies.reset();
});

describe('createSession', () => {
  it('stores only the SHA-256 of the token it puts in the cookie', async () => {
    h.db.session.create.mockResolvedValue({ id: 'sess-1' });

    await createSession('user-1');

    const created = h.db.session.create.mock.calls[0]?.[0] as { data: { tokenHash: string } };
    const cookie = lastSet();

    // The security property: a database dump must not yield live sessions, so
    // the raw bearer token exists only in the cookie.
    expect(created.data.tokenHash).toBe(sha256(cookie.value));
    expect(created.data.tokenHash).not.toBe(cookie.value);
    expect(cookie.value).not.toHaveLength(0);
  });

  it('mints a different token for every session', async () => {
    h.db.session.create.mockResolvedValue({ id: 'sess' });

    await createSession('user-1');
    await createSession('user-1');

    expect(h.cookies.sets[0]?.value).not.toBe(h.cookies.sets[1]?.value);
  });

  it('sets the cookie httpOnly, sameSite=lax, path=/ and expiring at the session TTL', async () => {
    h.db.session.create.mockResolvedValue({ id: 'sess-1' });
    const before = Date.now();

    await createSession('user-1');

    const cookie = lastSet();
    expect(cookie.name).toBe(SESSION_COOKIE);
    expect(cookie.options.httpOnly).toBe(true);
    expect(cookie.options.sameSite).toBe('lax');
    expect(cookie.options.path).toBe('/');

    const sixHours = 6 * 60 * 60 * 1000;
    const expires = cookie.options.expires?.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + sixHours);
    expect(expires).toBeLessThanOrEqual(Date.now() + sixHours + 1000);

    // The row must expire with the cookie, or a stolen cookie outlives its record.
    const created = h.db.session.create.mock.calls[0]?.[0] as { data: { expiresAt: Date } };
    expect(created.data.expiresAt.getTime()).toBe(expires);
  });

  it('truncates a long user agent to the column width', async () => {
    h.db.session.create.mockResolvedValue({ id: 'sess-1' });

    await createSession('user-1', 'x'.repeat(400));

    const created = h.db.session.create.mock.calls[0]?.[0] as { data: { userAgent?: string } };
    expect(created.data.userAgent).toHaveLength(255);
  });
});

/**
 * `cookieSecure` is derived in `env.server.ts` and frozen on first read, so
 * each case needs a fresh module graph. The prisma/cookie mocks are hoisted
 * singletons and therefore survive the reset.
 */
describe('session cookie Secure flag', () => {
  async function setCookieWith(env: Record<string, string | undefined>): Promise<boolean> {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
    try {
      const mod = await import('@/features/auth/session');
      h.db.session.create.mockResolvedValue({ id: 'sess-1' });
      await mod.createSession('user-1');
      return lastSet().options.secure === true;
    } finally {
      process.env = saved;
      vi.resetModules();
    }
  }

  it('is off outside production when COOKIE_SECURE is unset', async () => {
    await expect(setCookieWith({ NODE_ENV: 'development', COOKIE_SECURE: undefined })).resolves.toBe(
      false,
    );
  });

  it('is on in production', async () => {
    await expect(setCookieWith({ NODE_ENV: 'production', COOKIE_SECURE: undefined })).resolves.toBe(
      true,
    );
  });

  it('is forced on by COOKIE_SECURE=true when TLS terminates upstream', async () => {
    await expect(setCookieWith({ NODE_ENV: 'development', COOKIE_SECURE: 'true' })).resolves.toBe(
      true,
    );
  });

  it('is forced off by COOKIE_SECURE=false even in production', async () => {
    await expect(setCookieWith({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).resolves.toBe(
      false,
    );
  });
});

describe('getCurrentUser', () => {
  it('returns null and never queries when there is no session cookie', async () => {
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(h.db.session.findUnique).not.toHaveBeenCalled();
  });

  it('looks the session up by the hash of the cookie, not the cookie itself', async () => {
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.findUnique.mockResolvedValue(null);

    await expect(getCurrentUser()).resolves.toBeNull();

    const args = h.db.session.findUnique.mock.calls[0]?.[0] as {
      where: { tokenHash: string };
    };
    expect(args.where.tokenHash).toBe(sha256('raw-token'));
  });

  it('returns null and deletes the row for an expired session', async () => {
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1000),
      user: activeUser(),
    });
    h.db.session.deleteMany.mockResolvedValue({ count: 1 });

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(h.db.session.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
  });

  // A deactivated candidate must lose access immediately, without waiting for
  // their session to expire.
  it('returns null for a live session belonging to a deactivated user', async () => {
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: activeUser({ isActive: false }),
    });

    await expect(getCurrentUser()).resolves.toBeNull();
    expect(h.db.session.deleteMany).not.toHaveBeenCalled();
  });

  it('returns the user for a live session', async () => {
    const user = activeUser();
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.findUnique.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user,
    });

    await expect(getCurrentUser()).resolves.toEqual(user);
  });
});

describe('destroySession', () => {
  it('deletes the row keyed by the hashed cookie and clears the cookie', async () => {
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.deleteMany.mockResolvedValue({ count: 1 });

    await destroySession();

    expect(h.db.session.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: sha256('raw-token') },
    });
    expect(h.cookies.deletes).toContain(SESSION_COOKIE);
    expect(h.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('still clears the cookie when there is no session row to delete', async () => {
    await destroySession();

    expect(h.db.session.deleteMany).not.toHaveBeenCalled();
    expect(h.cookies.deletes).toContain(SESSION_COOKIE);
  });

  // Logout must not 500 because the row vanished concurrently.
  it('clears the cookie even if the delete fails', async () => {
    h.cookies.seed(SESSION_COOKIE, 'raw-token');
    h.db.session.deleteMany.mockRejectedValue(new Error('connection lost'));

    await expect(destroySession()).resolves.toBeUndefined();
    expect(h.cookies.deletes).toContain(SESSION_COOKIE);
  });
});

describe('bulk session invalidation', () => {
  it('destroyAllSessionsFor removes every row for the user', async () => {
    h.db.session.deleteMany.mockResolvedValue({ count: 3 });

    await destroyAllSessionsFor('user-1');

    expect(h.db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });

  it('purgeExpiredSessions reports how many rows it removed', async () => {
    h.db.session.deleteMany.mockResolvedValue({ count: 7 });

    await expect(purgeExpiredSessions()).resolves.toBe(7);
    const args = h.db.session.deleteMany.mock.calls[0]?.[0] as {
      where: { expiresAt: { lte: Date } };
    };
    expect(args.where.expiresAt.lte).toBeInstanceOf(Date);
  });
});

describe('constantTimeEquals', () => {
  it('is true for identical strings', () => {
    expect(constantTimeEquals('abc123', 'abc123')).toBe(true);
  });

  it('is false for same-length strings that differ', () => {
    expect(constantTimeEquals('abc123', 'abc124')).toBe(false);
  });

  // Unequal lengths must short-circuit rather than throwing out of
  // timingSafeEqual, which requires equal-length buffers.
  it('is false, not an exception, for different lengths', () => {
    expect(constantTimeEquals('abc', 'abcdef')).toBe(false);
  });
});
