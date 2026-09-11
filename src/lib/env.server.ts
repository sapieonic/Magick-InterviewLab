import 'server-only';
import { z } from 'zod';

/** Treats an empty or whitespace-only variable as absent rather than as a value. */
const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/**
 * Server-side environment. Validated once, lazily, and never imported from a
 * Client Component — `server-only` makes that a build error rather than a leak.
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
  MAILJET_SANDBOX: z
    .enum(['true', 'false'])
    .default('false')
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
  }
});

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
    fromName: value.MAIL_FROM_NAME ?? 'MagicVoice InterviewLab',
    ...(value.MAIL_REPLY_TO ? { replyTo: value.MAIL_REPLY_TO } : {}),
    sandbox: value.MAILJET_SANDBOX,
  };
}

/** Cheap predicate for the UI and the actions: is email available at all? */
export function isEmailConfigured(): boolean {
  return serverEnv().mail !== null;
}
