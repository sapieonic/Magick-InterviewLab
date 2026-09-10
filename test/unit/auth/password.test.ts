import { describe, expect, it, vi } from 'vitest';

// `password.ts` declares itself server-only; the package is inert under Node
// but mocking it keeps the suite independent of how it resolves conditions.
vi.mock('server-only', () => ({}));

import { hashPassword, isArgon2Hash, verifyPassword } from '@/features/auth/password';

// Real Argon2 work: ~40ms per hash at the configured cost. The count here is
// deliberately small.
describe('hashPassword', () => {
  it('produces an Argon2id digest', async () => {
    const digest = await hashPassword('correct horse 42');
    expect(digest.startsWith('$argon2id$')).toBe(true);
  });

  it('salts every hash, so the same password never yields the same digest', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password-1'),
      hashPassword('same-password-1'),
    ]);
    expect(a).not.toEqual(b);
  });

  it('refuses an empty password rather than hashing nothing', async () => {
    await expect(hashPassword('')).rejects.toThrow(/must not be empty/i);
  });
});

describe('verifyPassword', () => {
  it('accepts the password that produced the digest and rejects any other', async () => {
    const digest = await hashPassword('s3cret-passphrase');
    await expect(verifyPassword(digest, 's3cret-passphrase')).resolves.toBe(true);
    await expect(verifyPassword(digest, 's3cret-passphras')).resolves.toBe(false);
  });

  // Security property: a corrupt or truncated stored hash must read as "wrong
  // password". If it threw, the 500 would tell an attacker the account exists
  // and would take the login route down for that user instead of failing it.
  it.each([
    ['empty digest', ''],
    ['plaintext in the hash column', 'hunter2'],
    ['a bcrypt digest', '$2b$12$abcdefghijklmnopqrstuv'],
    ['a truncated argon2 digest', '$argon2id$v=19$m=19456,t=2,p=1$'],
  ])('returns false without throwing for %s', async (_label, digest) => {
    await expect(verifyPassword(digest, 'anything')).resolves.toBe(false);
  });

  it('returns false for an empty candidate password', async () => {
    const digest = await hashPassword('another-password-9');
    await expect(verifyPassword(digest, '')).resolves.toBe(false);
  });
});

describe('isArgon2Hash', () => {
  it.each(['$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA', '$argon2i$v=19$x', '$argon2d$v=19$x'])(
    'accepts the argon2 variant in %s',
    (value) => {
      expect(isArgon2Hash(value)).toBe(true);
    },
  );

  it.each([
    ['', 'an empty string'],
    ['hunter2', 'plaintext'],
    ['$2b$12$abcdefghijklmnopqrstuv', 'a bcrypt digest'],
    ['argon2id$v=19$', 'a digest missing its leading $'],
    ['$argon2x$v=19$', 'an unknown argon2 variant'],
  ])('rejects %s (%s)', (value) => {
    expect(isArgon2Hash(value)).toBe(false);
  });
});
