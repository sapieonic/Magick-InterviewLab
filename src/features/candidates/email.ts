import 'server-only';
import { sendEmail } from '@/lib/email/mailjet';
import { candidateWelcomeEmail } from '@/lib/email/templates';
import { isEmailConfigured } from '@/lib/env.server';

/**
 * What happened to the invitation, as far as the admin needs to know.
 *
 * This travels back in the action result, so it is a closed set of slugs and
 * never a message from Mailjet: the outcome an admin acts on is "did it go",
 * and a provider string on an RSC payload is one more thing to sanitise.
 */
export type WelcomeEmailStatus =
  /** Delivered to Mailjet for sending. */
  | 'sent'
  /** Accepted by Mailjet in sandbox mode — validated, deliberately not delivered. */
  | 'sandboxed'
  /** The admin cleared the checkbox. */
  | 'not_requested'
  /** No Mailjet credentials on this deployment; the checkbox is not offered. */
  | 'not_configured'
  /** Mailjet refused or could not be reached. The account exists regardless. */
  | 'failed';

export interface SendWelcomeInput {
  name: string;
  email: string;
  temporaryPassword: string;
  interviewTitle?: string;
  requested: boolean;
}

/**
 * Send the invitation for a newly created candidate.
 *
 * Never throws and never rejects: it is called *after* the user row is
 * committed, and an unreachable mail provider must not turn a successful
 * creation into an error the admin reads as "nothing happened". The admin
 * still has the password on screen, so a `failed` here degrades to exactly
 * the hand-over flow that existed before this feature.
 */
export async function sendCandidateWelcomeEmail(
  input: SendWelcomeInput,
): Promise<WelcomeEmailStatus> {
  if (!input.requested) return 'not_requested';
  if (!isEmailConfigured()) return 'not_configured';

  const result = await sendEmail(
    candidateWelcomeEmail({
      name: input.name,
      email: input.email,
      temporaryPassword: input.temporaryPassword,
      ...(input.interviewTitle ? { interviewTitle: input.interviewTitle } : {}),
    }),
  );

  if (!result.ok) {
    // The reason is logged, not returned: it is operator information, and the
    // admin's next step is the same whatever Mailjet said.
    console.error('[candidates] welcome email not sent', { reason: result.reason });
    return 'failed';
  }

  return result.sandbox ? 'sandboxed' : 'sent';
}
