import 'server-only';
import { serverEnv, type MailConfig } from '@/lib/env.server';

/**
 * Mailjet Send API v3.1 transport.
 *
 * Spoken to over `fetch` rather than through `node-mailjet`: one POST with
 * Basic auth is the whole surface we need, and the SDK would add a dependency
 * (and its transitive tree) to a Next.js server bundle for no gain.
 *
 * Nothing here ever logs the message body. A welcome email carries a
 * plaintext temporary password, so a well-meant `console.error(payload)` on
 * the failure path would write that credential to the container logs — which
 * is exactly the place it must never reach.
 */

const MAILJET_SEND_URL = 'https://api.mailjet.com/v3.1/send';

/** Mailjet is a dependency of a request an admin is waiting on, not a job queue. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  text: string;
}

export type SendResult =
  { ok: true; messageId: string | null; sandbox: boolean } | { ok: false; reason: string };

/** Shape of the v3.1 response we read. Everything else is ignored. */
interface MailjetResponse {
  Messages?: Array<{
    Status?: string;
    To?: Array<{ MessageID?: number | string; MessageUUID?: string }>;
    Errors?: Array<{ ErrorMessage?: string; ErrorCode?: string; ErrorIdentifier?: string }>;
  }>;
}

function basicAuth(mail: MailConfig): string {
  return `Basic ${Buffer.from(`${mail.apiKey}:${mail.apiSecret}`).toString('base64')}`;
}

/**
 * v3.1 reports per-message failures *inside a 200-family response* (200 all
 * sent, 207 partial, 400 all rejected), so an `res.ok` check alone would call
 * a rejected recipient a success. The per-message `Status` is the truth.
 */
function readOutcome(body: MailjetResponse, sandbox: boolean): SendResult {
  const message = body.Messages?.[0];
  if (!message) return { ok: false, reason: 'Mailjet returned no message status.' };

  if (message.Status !== 'success') {
    const error = message.Errors?.[0];
    const detail = error?.ErrorMessage ?? message.Status ?? 'unknown error';
    return { ok: false, reason: `Mailjet rejected the message: ${detail}` };
  }

  const id = message.To?.[0]?.MessageUUID ?? message.To?.[0]?.MessageID ?? null;
  return { ok: true, messageId: id === null ? null : String(id), sandbox };
}

/**
 * Send one message. Never throws: every failure — network, auth, rejection —
 * comes back as `{ ok: false }` so the caller decides what a failed email
 * means for the operation it was part of. For candidate creation it means
 * "the account still exists, tell the admin to hand the password over".
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const { mail } = serverEnv();
  if (!mail) return { ok: false, reason: 'Email is not configured on this deployment.' };

  const payload = {
    SandboxMode: mail.sandbox,
    Messages: [
      {
        From: { Email: mail.fromEmail, Name: mail.fromName },
        To: [{ Email: message.to, ...(message.toName ? { Name: message.toName } : {}) }],
        ...(mail.replyTo ? { ReplyTo: { Email: mail.replyTo } } : {}),
        Subject: message.subject,
        TextPart: message.text,
        HTMLPart: message.html,
      },
    ],
  };

  let response: Response;
  try {
    response = await fetch(MAILJET_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(mail),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout arrives here as an AbortError; both are "we do not know
    // whether it was delivered", which the caller must treat as not sent.
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `Mailjet did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : 'Could not reach Mailjet.';
    console.error('[mailjet] request failed', { reason });
    return { ok: false, reason };
  }

  // 401/403 mean bad credentials, which is a configuration fault worth
  // naming rather than folding into a generic failure.
  if (response.status === 401 || response.status === 403) {
    console.error('[mailjet] authentication rejected', { status: response.status });
    return { ok: false, reason: 'Mailjet rejected the API credentials.' };
  }

  let body: MailjetResponse;
  try {
    body = (await response.json()) as MailjetResponse;
  } catch {
    console.error('[mailjet] unreadable response', { status: response.status });
    return { ok: false, reason: `Mailjet returned an unreadable response (${response.status}).` };
  }

  const outcome = readOutcome(body, mail.sandbox);
  if (!outcome.ok) console.error('[mailjet] send rejected', { status: response.status });
  return outcome;
}
