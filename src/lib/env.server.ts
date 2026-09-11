import 'server-only';
import { z } from 'zod';
import { publicEnv } from './env';

/** Treats an empty or whitespace-only variable as absent rather than as a value. */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/**
 * Server-side environment. Validated once and never imported from a Client
 * Component — `server-only` makes that a build error rather than a leak.
 *
 * `serverEnv()` memoises, so the *parse* is lazy; what makes the failure
 * prompt is `src/instrumentation.ts`, which calls it during boot. Without
 * that hook a bad variable surfaces as a 500 on the first request that
 * happens to read config — which on a Node host or Vercel is a deploy that
 * "succeeds" and then serves errors.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_NAME: z.string().default('MagicVoice Admin'),

  SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 30)
    .default(12),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  SEED_CANDIDATE_EMAIL: z.string().email().default('candidate@magicvoice.local'),
  SEED_CANDIDATE_PASSWORD: z.string().optional(),
  SEED_DEMO_DATA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // --- outbound email (Mailjet) -------------------------------------------
  // Blank is the same as unset: a deployment that exports the variables from
  // a secret store gets empty strings when the secret is missing, and a
  // half-configured mailer that silently never sends is worse than one that
  // is plainly off.
  MAILJET_API_KEY: optionalString,
  MAILJET_API_SECRET: optionalString,
  MAIL_FROM_EMAIL: optionalString.pipe(z.string().email().optional()),
  MAIL_FROM_NAME: optionalString,
  MAIL_REPLY_TO: optionalString.pipe(z.string().email().optional()),
  // Mailjet accepts, authenticates and validates the payload but delivers
  // nothing. The way to exercise this path against the real API without
  // mailing a real candidate.
  //
  // Blank-is-unset applies here too, and it matters more than it looks:
  // `serverEnv()` is read on nearly every request, so a bare `z.enum` would
  // turn `MAILJET_SANDBOX=""` — which is what uncommenting the line in
  // `.env.example` and leaving the value empty produces — into a 500 on
  // *login and every page*, not a mail-feature fault.
  MAILJET_SANDBOX: optionalString
    .pipe(z.enum(['true', 'false']).optional())
    .transform((v) => v === 'true'),
});

/** The three variables that together make outbound email possible. */
const MAIL_REQUIRED = ['MAILJET_API_KEY', 'MAILJET_API_SECRET', 'MAIL_FROM_EMAIL'] as const;

/**
 * Outbound email is opt-in: with none of the three set, the app runs exactly
 * as it did before and candidate emails are simply not offered.
 *
 * A *partial* configuration is refused at startup instead. The failure it
 * would otherwise produce is the bad kind — the admin sees a "send the
 * welcome email" checkbox, ticks it, and nothing is ever delivered, with the
 * only trace a log line nobody reads.
 */
const checkedSchema = serverSchema.superRefine((value, ctx) => {
  const missing = MAIL_REQUIRED.filter((key) => value[key] === undefined);
  if (missing.length > 0 && missing.length < MAIL_REQUIRED.length) {
    for (const key of missing) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `Required once any of ${MAIL_REQUIRED.join(', ')} is set. Set all three to enable email, or none to disable it.`,
      });
    }
    return;
  }
  if (missing.length === 0 && !isReachableAppUrl(publicEnv.appUrl)) {
    ctx.addIssue({
      code: 'custom',
      path: ['NEXT_PUBLIC_APP_URL'],
      message: `Must be the deployment's real URL once email is enabled — every invitation links to ${publicEnv.appUrl}/login, which no candidate can reach.`,
    });
  }
});

/**
 * Refuse a sign-in link a candidate could not possibly follow.
 *
 * `NEXT_PUBLIC_APP_URL` defaults to `http://localhost:3000`, and the
 * Dockerfile bakes that same default as a build arg — so a deployment that
 * configures Mailjet correctly and forgets this one variable mails *every*
 * candidate a dead link, reports it to the admin as sent, and (there being no
 * resend) cannot take it back. The whole point of the all-or-nothing check
 * above is that a mailer which cannot deliver should not start; a mailer that
 * delivers an unusable link is the same fault one step later.
 *
 * Loopback is the failure worth catching, not every possible mistake: a
 * wrong-but-public hostname is indistinguishable from a correct one here.
 */
function isReachableAppUrl(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return false;
  }
  return !['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', ''].includes(host);
}

/** Resolved Mailjet credentials and sender identity. Null when email is off. */
export interface MailConfig {
  apiKey: string;
  apiSecret: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string;
  sandbox: boolean;
}

export type ServerEnv = z.infer<typeof serverSchema> & {
  cookieSecure: boolean;
  /** Null when outbound email is not configured — the one flag to branch on. */
  mail: MailConfig | null;
};

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = checkedSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  const value = parsed.data;
  cached = {
    ...value,
    cookieSecure: value.COOKIE_SECURE ?? value.NODE_ENV === 'production',
    mail: mailConfig(value),
  };
  return cached;
}

function mailConfig(value: z.infer<typeof serverSchema>): MailConfig | null {
  const { MAILJET_API_KEY, MAILJET_API_SECRET, MAIL_FROM_EMAIL } = value;
  if (!MAILJET_API_KEY || !MAILJET_API_SECRET || !MAIL_FROM_EMAIL) return null;
  return {
    apiKey: MAILJET_API_KEY,
    apiSecret: MAILJET_API_SECRET,
    fromEmail: MAIL_FROM_EMAIL,
    // Falls back to the same brand the subject and body are built from, so a
    // rebranded deployment cannot send "Your Acme InterviewLab account" from
    // a sender called "MagicVoice InterviewLab".
    fromName: value.MAIL_FROM_NAME ?? `${publicEnv.appName} InterviewLab`,
    ...(value.MAIL_REPLY_TO ? { replyTo: value.MAIL_REPLY_TO } : {}),
    sandbox: value.MAILJET_SANDBOX,
  };
}

/** Cheap predicate for the UI and the actions: is email available at all? */
export function isEmailConfigured(): boolean {
  return serverEnv().mail !== null;
}
