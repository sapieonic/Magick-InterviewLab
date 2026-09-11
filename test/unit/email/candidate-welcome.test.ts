import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { vi: vitest } = await import('vitest');
  return { sendEmail: vitest.fn(), isEmailConfigured: vitest.fn() };
});

vi.mock('@/lib/email/mailjet', () => ({ sendEmail: h.sendEmail }));
vi.mock('@/lib/env.server', () => ({ isEmailConfigured: h.isEmailConfigured }));

import { sendCandidateWelcomeEmail } from '@/features/candidates/email';

const INPUT = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  temporaryPassword: 'Temp0rary1',
  requested: true,
};

beforeEach(() => {
  h.sendEmail.mockReset();
  h.isEmailConfigured.mockReset();
  h.isEmailConfigured.mockReturnValue(true);
  h.sendEmail.mockResolvedValue({ ok: true, messageId: 'uuid-1', sandbox: false });
});

describe('sendCandidateWelcomeEmail — when it sends at all', () => {
  it('sends the invitation when asked and configured', async () => {
    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('sent');
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });

  // The admin cleared the checkbox. Nothing may be sent, and the configuration
  // must not even be consulted — the choice is the admin's, not the env's.
  it('sends nothing when the admin did not ask', async () => {
    await expect(sendCandidateWelcomeEmail({ ...INPUT, requested: false })).resolves.toBe(
      'not_requested',
    );
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.isEmailConfigured).not.toHaveBeenCalled();
  });

  it('reports an unconfigured deployment without calling the transport', async () => {
    h.isEmailConfigured.mockReturnValue(false);

    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('not_configured');
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('distinguishes a sandbox acceptance from a real delivery', async () => {
    h.sendEmail.mockResolvedValue({ ok: true, messageId: 'uuid-1', sandbox: true });

    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('sandboxed');
  });
});

describe('sendCandidateWelcomeEmail — the message it builds', () => {
  it('carries the candidate, the password and the assigned interview', async () => {
    await sendCandidateWelcomeEmail({ ...INPUT, interviewTitle: 'Backend screen' });

    const message = h.sendEmail.mock.calls[0]?.[0] as {
      to: string;
      text: string;
      html: string;
    };
    expect(message.to).toBe('ada@example.com');
    expect(message.text).toContain('Temp0rary1');
    expect(message.text).toContain('Backend screen');
  });

  it('carries the interview duration when the interview is timed', async () => {
    await sendCandidateWelcomeEmail({
      ...INPUT,
      interviewTitle: 'Backend screen',
      interviewDurationMinutes: 45,
    });

    const message = h.sendEmail.mock.calls[0]?.[0] as { text: string };
    expect(message.text).toContain('45 minutes');
  });
});

/**
 * This runs *after* the user row is committed. A rejection here would
 * propagate out of the Server Action and be reported to the admin as a failed
 * creation — of an account that exists, with a password only their browser
 * still holds.
 */
describe('sendCandidateWelcomeEmail — a mail failure is not a creation failure', () => {
  it('returns failed rather than rejecting when Mailjet refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendEmail.mockResolvedValue({ ok: false, reason: 'Mailjet rejected the API credentials.' });

    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('failed');
  });

  // The reason is operator information; the admin's next step is the same
  // whatever Mailjet said, and a provider string on an RSC payload is one
  // more thing to sanitise.
  it('keeps the provider reason out of the returned status', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendEmail.mockResolvedValue({ ok: false, reason: 'key sk_live_123 is invalid' });

    const status = await sendCandidateWelcomeEmail(INPUT);

    expect(status).toBe('failed');
    expect(JSON.stringify(status)).not.toContain('sk_live_123');
  });

  /**
   * The docblock promises "never throws". Without a catch that promise rests
   * on `sendEmail` and `isEmailConfigured` — the latter parses the whole
   * environment and can throw on its own.
   */
  it('returns failed rather than rejecting when the transport throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendEmail.mockRejectedValue(new Error('socket hang up'));

    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('failed');
  });

  it('returns failed rather than rejecting when reading the config throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.isEmailConfigured.mockImplementation(() => {
      throw new Error('Invalid server environment');
    });

    await expect(sendCandidateWelcomeEmail(INPUT)).resolves.toBe('failed');
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it('never logs the password it just tried to send', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.sendEmail.mockResolvedValue({ ok: false, reason: 'nope' });

    await sendCandidateWelcomeEmail(INPUT);

    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('Temp0rary1');
  });
});
