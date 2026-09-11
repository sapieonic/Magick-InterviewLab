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
 * exists to remove. What makes it defensible is that the credential is
 * single-use by construction: the account is created with
 * `mustChangePassword`, so the first thing the candidate does is replace it,
 * and the value in the mailbox stops working at that moment.
 */
export function candidateWelcomeEmail(input: CandidateWelcomeInput): EmailMessage {
  const app = publicEnv.appName;
  const url = loginUrl();
  const assigned = input.interviewTitle
    ? `You have been assigned: ${input.interviewTitle}.`
    : 'Your interview will appear on your dashboard once it has been assigned.';

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
    '',
    'If you were not expecting this email, you can ignore it.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;">
      <tr>
        <td style="padding:24px;">
          <h1 style="margin:0 0 16px;font-size:18px;line-height:1.4;">Your ${escapeHtml(app)} InterviewLab account</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">Hi ${escapeHtml(input.name)}, an account has been created for you.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 16px;background:#f4f4f5;border-radius:6px;">
            <tr>
              <td style="padding:16px;font-size:14px;line-height:1.8;">
                <div><strong>Email:</strong> ${escapeHtml(input.email)}</div>
                <div><strong>Temporary password:</strong> <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(input.temporaryPassword)}</code></div>
              </td>
            </tr>
          </table>
          <p style="margin:0 0 20px;font-size:14px;line-height:1.6;">You will be asked to choose your own password the first time you sign in — this temporary one stops working at that point.</p>
          <p style="margin:0 0 20px;">
            <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 18px;background:#18181b;color:#ffffff;font-size:14px;text-decoration:none;border-radius:6px;">Sign in</a>
          </p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;">${escapeHtml(assigned)}</p>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#71717a;">If you were not expecting this email, you can ignore it.</p>
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
