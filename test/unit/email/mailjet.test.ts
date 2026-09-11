import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MailConfig } from '@/lib/env.server';

vi.mock('server-only', () => ({}));

const h = await vi.hoisted(async () => {
  const { vi: vitest } = await import('vitest');
  return { serverEnv: vitest.fn() };
});

vi.mock('@/lib/env.server', () => ({ serverEnv: h.serverEnv }));

import { sendEmail, type EmailMessage } from '@/lib/email/mailjet';

const MAIL: MailConfig = {
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  fromEmail: 'interviews@example.com',
  fromName: 'InterviewLab',
  sandbox: false,
};

const MESSAGE: EmailMessage = {
  to: 'ada@example.com',
  toName: 'Ada',
  subject: 'Your account',
  html: '<p>hello</p>',
  text: 'hello',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The one Mailjet body shape that means "sent". */
function accepted(): unknown {
  return { Messages: [{ Status: 'success', To: [{ MessageUUID: 'uuid-1', MessageID: 42 }] }] };
}

/** The `data` argument of the single `fetch` call, parsed back from JSON. */
function sentPayload(): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error('expected fetch to have been called');
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  h.serverEnv.mockReset();
  h.serverEnv.mockReturnValue({ mail: MAIL });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendEmail — request shape', () => {
  it('posts one v3.1 message with Basic auth built from the configured pair', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, accepted()));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: true, messageId: 'uuid-1', sandbox: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mailjet.com/v3.1/send');
    expect(init.method).toBe('POST');
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${Buffer.from('key-1:secret-1').toString('base64')}`);

    const payload = sentPayload() as {
      SandboxMode: boolean;
      Messages: Array<Record<string, unknown>>;
    };
    expect(payload.SandboxMode).toBe(false);
    expect(payload.Messages).toHaveLength(1);
    expect(payload.Messages[0]).toMatchObject({
      From: { Email: 'interviews@example.com', Name: 'InterviewLab' },
      To: [{ Email: 'ada@example.com', Name: 'Ada' }],
      Subject: 'Your account',
      TextPart: 'hello',
      HTMLPart: '<p>hello</p>',
    });
  });

  // Omitted rather than sent as null: Mailjet validates the object when the
  // key is present, so an empty ReplyTo is a rejected message, not a no-op.
  it('omits ReplyTo entirely when none is configured, and sends it when one is', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, accepted()));
    await sendEmail(MESSAGE);
    expect((sentPayload() as { Messages: Array<object> }).Messages[0]).not.toHaveProperty(
      'ReplyTo',
    );

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse(200, accepted()));
    h.serverEnv.mockReturnValue({ mail: { ...MAIL, replyTo: 'talent@example.com' } });
    await sendEmail(MESSAGE);
    expect(
      (sentPayload() as { Messages: Array<Record<string, unknown>> }).Messages[0],
    ).toMatchObject({ ReplyTo: { Email: 'talent@example.com' } });
  });

  it('reports a sandbox send as sandboxed rather than as delivered', async () => {
    h.serverEnv.mockReturnValue({ mail: { ...MAIL, sandbox: true } });
    fetchMock.mockResolvedValue(jsonResponse(200, accepted()));

    const result = await sendEmail(MESSAGE);

    expect(result).toEqual({ ok: true, messageId: 'uuid-1', sandbox: true });
    expect(sentPayload().SandboxMode).toBe(true);
  });

  it('does not call Mailjet at all when email is not configured', async () => {
    h.serverEnv.mockReturnValue({ mail: null });

    const result = await sendEmail(MESSAGE);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The failure mode this guards against: v3.1 reports a *rejected recipient*
 * inside a 200-family response, so an `res.ok` check alone reports a message
 * that was never sent as sent — and the admin stops handing the password over.
 */
describe('sendEmail — a 200 is not a delivery', () => {
  it('treats a per-message error status as a failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        Messages: [
          { Status: 'error', Errors: [{ ErrorMessage: '"To" is invalid', ErrorCode: 'mj-0013' }] },
        ],
      }),
    );

    const result = await sendEmail(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('"To" is invalid');
  });

  it('treats a response with no message status as a failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { Messages: [] }));

    expect((await sendEmail(MESSAGE)).ok).toBe(false);
  });

  it('treats an unreadable body as a failure rather than throwing', async () => {
    fetchMock.mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));

    const result = await sendEmail(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('502');
  });

  it('names bad credentials separately, without reading a body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));

    const result = await sendEmail(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('credentials');
  });
});

/**
 * Every caller treats a send as best-effort, which only holds if this never
 * throws: a rejection here would propagate out of a Server Action whose
 * database write has already committed.
 */
describe('sendEmail — never throws', () => {
  it('returns a failure when the network is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(sendEmail(MESSAGE)).resolves.toMatchObject({ ok: false });
  });

  it('returns a failure when the request times out', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    const result = await sendEmail(MESSAGE);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('did not respond');
  });

  it('passes an abort signal so a hung provider cannot hold the request open', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, accepted()));

    await sendEmail(MESSAGE);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * A welcome email carries a plaintext temporary password. Logging the payload
 * on the failure path would write that credential to the container logs,
 * which is the one place it must never reach.
 */
describe('sendEmail — the body never reaches a log', () => {
  it('logs neither the message body nor the credentials when a send fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      jsonResponse(200, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'nope' }] }] }),
    );

    await sendEmail({ ...MESSAGE, text: 'password: Sup3rSecret', html: '<p>Sup3rSecret</p>' });

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain('Sup3rSecret');
    expect(logged).not.toContain('secret-1');
  });
});
