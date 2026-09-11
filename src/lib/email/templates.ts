import { publicEnv } from '@/lib/env';
import type { EmailMessage } from './mailjet';

/**
 * Email bodies. Kept free of `server-only` and of any I/O so the rendering is
 * a pure function of its input and can be asserted directly in a unit test —
 * the parts that matter (the password appears once, everything interpolated
 * is escaped) are properties of the string, not of the transport.
 */

/**
 * Mail clients render HTML, so every interpolated value is escaped. A
 * candidate's name is admin-supplied free text, and the generated password
 * alphabet excludes these characters today — but "today" is not a control,
 * and an unescaped `&` in a name is enough to mangle a password that follows.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface CandidateWelcomeInput {
  name: string;
  email: string;
  temporaryPassword: string;
  /** Title of the interview assigned at creation, when one was. */
  interviewTitle?: string;
  /** Duration of that interview, when it is timed. */
  interviewDurationMinutes?: number;
}

function loginUrl(): string {
  return `${publicEnv.appUrl.replace(/\/+$/, '')}/login`;
}

/**
 * The invitation a candidate receives when an admin creates their account.
 *
 * It carries the temporary password deliberately. The alternative — "your
 * administrator will contact you" — makes the email an announcement the
 * candidate cannot act on, leaving the out-of-band handover that this feature
 * exists to remove. `mustChangePassword` means the guards refuse every page
 * until it is replaced, so it buys nothing but the password change itself.
 *
 * Be precise about what that is NOT, because it is easy to overstate: the
 * credential is **not** single-use and **not** time-limited. Nothing expires
 * it — `User` carries no expiry column, only `Session.expiresAt` — so it
 * stays valid until the candidate chooses to sign in and rotate it, and a
 * candidate who never opens the email leaves a working credential in a
 * mailbox indefinitely. Anyone else with access to that mailbox can rotate it
 * first and lock the real candidate out. The mitigation is that the window is
 * short in practice; nothing in the code makes it short. A single-use signed
 * invite link (a token row with `expiresAt`/`usedAt`, landing on a
 * set-password page) is the design that actually closes this, and it would
 * reuse this transport and template unchanged.
 */
export function candidateWelcomeEmail(input: CandidateWelcomeInput): EmailMessage {
  const app = publicEnv.appName;
  const url = loginUrl();
  const assigned = input.interviewTitle
    ? `You have been assigned: ${input.interviewTitle}.`
    : 'Your interview will appear on your dashboard once it has been assigned.';

  /**
   * Opening the workspace is what stamps `startedAt` and starts the countdown
   * (see `startAssignment` in features/submissions/queries.ts), and it is
   * stamped once and never reset. Without this line the email invites someone
   * to click "Sign in" from a bus stop and silently burn their exam window.
   */
  const timing = input.interviewDurationMinutes
    ? `This is a timed exercise (${input.interviewDurationMinutes} minutes). The clock starts when you open the interview, so sign in when you are ready to begin.`
    : '';

  const text = [
    `Hi ${input.name},`,
    '',
    `An account has been created for you on ${app} InterviewLab.`,
    '',
    `Sign in at: ${url}`,
    `Email: ${input.email}`,
    `Temporary password: ${input.temporaryPassword}`,
    '',
    'You will be asked to choose your own password the first time you sign in.',
    'This temporary password stops working at that point.',
    '',
    assigned,
    ...(timing ? ['', timing] : []),
    '',
    'If you were not expecting this email, please reply and let us know.',
  ].join('\n');

  /*
   * Three mail-client constraints shape the markup below, none of which are
   * visible from reading the copy. Rationale lives here rather than in an
   * HTML comment because anything inside the literal is shipped to the
   * candidate and shown by "view source".
   *
   * 1. Gmail strips the html/head/body wrapper, so every text style is
   *    repeated on an inner wrapper instead of declared once on <body>.
   * 2. Outlook on Windows (the Word engine) ignores `display:inline-block`
   *    and `max-width`, and paints backgrounds on inline elements
   *    unreliably — a styled <a> can render as white-on-white. Hence the
   *    `bgcolor` table cell for the button, the mso ghost table for width,
   *    and the sign-in URL repeated as visible text: previously it existed
   *    only inside the href, leaving nothing to fall back to.
   * 3. `ui-monospace`/`SFMono-Regular` do not exist on Windows, so the
   *    password could land in a proportional font; `Consolas` leads the
   *    stack, and `word-break` keeps a 200-character password (which
   *    `passwordSchema` permits) inside the card.
   */
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${escapeHtml(app)} InterviewLab</title>
  </head>
  <body style="margin:0;padding:0;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your sign-in link and temporary password are inside.</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f6f7f9;">
      <tr>
        <td align="center" style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
          <!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;">
            <tr>
              <td style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
                <h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;color:#18181b;">Your ${escapeHtml(app)} InterviewLab account</h1>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#18181b;">Hi ${escapeHtml(input.name)}, an account has been created for you.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;background:#f4f4f5;border-radius:6px;">
                  <tr>
                    <td style="padding:16px;font-size:14px;line-height:1.8;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      <div><strong>Email:</strong> ${escapeHtml(input.email)}</div>
                      <div><strong>Temporary password:</strong> <code style="font-family:Consolas,'Courier New',monospace;word-break:break-all;">${escapeHtml(input.temporaryPassword)}</code></div>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#18181b;">You will be asked to choose your own password the first time you sign in — this temporary one stops working at that point.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;">
                  <tr>
                    <td bgcolor="#18181b" style="border-radius:6px;">
                      <a href="${escapeHtml(url)}" style="display:block;padding:10px 18px;color:#ffffff;font-size:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;text-decoration:none;">Sign in</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#52525b;">Or go to ${escapeHtml(url)}</p>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#18181b;">${escapeHtml(assigned)}</p>
                ${timing ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#18181b;"><strong>${escapeHtml(timing)}</strong></p>` : ''}
                <p style="margin:0;font-size:12px;line-height:1.6;color:#52525b;">If you were not expecting this email, please reply and let us know.</p>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    to: input.email,
    toName: input.name,
    subject: `Your ${app} InterviewLab account`,
    text,
    html,
  };
}
