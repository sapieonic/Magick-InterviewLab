import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * `serverEnv()` memoises, so every case needs a fresh module instance —
 * otherwise the first import in the file decides what every later assertion
 * sees.
 */
async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('@/lib/env.server');
}

const MAIL_VARS = [
  'MAILJET_API_KEY',
  'MAILJET_API_SECRET',
  'MAIL_FROM_EMAIL',
  'MAIL_FROM_NAME',
  'MAIL_REPLY_TO',
  'MAILJET_SANDBOX',
];

const CONFIGURED = {
  MAILJET_API_KEY: 'key-1',
  MAILJET_API_SECRET: 'secret-1',
  MAIL_FROM_EMAIL: 'interviews@example.com',
};

const original = { ...process.env };

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://localhost:5432/test';
  for (const key of MAIL_VARS) delete process.env[key];
});

afterEach(() => {
  process.env = { ...original };
  vi.resetModules();
});

describe('mail configuration — off by default', () => {
  it('leaves email disabled, and the app otherwise valid, when nothing is set', async () => {
    const { serverEnv, isEmailConfigured } = await loadEnv({});

    expect(serverEnv().mail).toBeNull();
    expect(isEmailConfigured()).toBe(false);
  });

  // A deployment that exports its variables from a secret store gets empty
  // strings for a secret that is missing. That is "unset", not "set to ''".
  it('treats blank variables as unset rather than as a broken configuration', async () => {
    const { serverEnv } = await loadEnv({
      MAILJET_API_KEY: '  ',
      MAILJET_API_SECRET: '',
      MAIL_FROM_EMAIL: '',
    });

    expect(serverEnv().mail).toBeNull();
  });
});

describe('mail configuration — resolved', () => {
  it('exposes the credentials and sender once all three are present', async () => {
    const { serverEnv, isEmailConfigured } = await loadEnv(CONFIGURED);

    expect(isEmailConfigured()).toBe(true);
    expect(serverEnv().mail).toMatchObject({
      apiKey: 'key-1',
      apiSecret: 'secret-1',
      fromEmail: 'interviews@example.com',
      sandbox: false,
    });
    expect(serverEnv().mail?.replyTo).toBeUndefined();
  });

  it('carries an explicit sender name, reply-to and sandbox flag', async () => {
    const { serverEnv } = await loadEnv({
      ...CONFIGURED,
      MAIL_FROM_NAME: 'Acme Talent',
      MAIL_REPLY_TO: 'talent@example.com',
      MAILJET_SANDBOX: 'true',
    });

    expect(serverEnv().mail).toMatchObject({
      fromName: 'Acme Talent',
      replyTo: 'talent@example.com',
      sandbox: true,
    });
  });
});

/**
 * The failure a partial configuration produces is the bad kind: the admin
 * sees the checkbox, ticks it, and nothing is ever delivered — the only trace
 * a log line nobody reads. Refusing at startup makes it loud instead.
 */
describe('mail configuration — a partial one is refused at startup', () => {
  it.each([
    ['the secret', { MAILJET_API_KEY: 'key-1', MAIL_FROM_EMAIL: 'a@example.com' }],
    ['the key', { MAILJET_API_SECRET: 'secret-1', MAIL_FROM_EMAIL: 'a@example.com' }],
    ['the sender', { MAILJET_API_KEY: 'key-1', MAILJET_API_SECRET: 'secret-1' }],
  ])('throws when %s is missing, naming what to set', async (_label, vars) => {
    const { serverEnv } = await loadEnv(vars);

    expect(() => serverEnv()).toThrow(/Set all three to enable email, or none to disable it/);
  });

  it('refuses a sender address that is not an email', async () => {
    const { serverEnv } = await loadEnv({ ...CONFIGURED, MAIL_FROM_EMAIL: 'not-an-address' });

    expect(() => serverEnv()).toThrow(/MAIL_FROM_EMAIL/);
  });
});
