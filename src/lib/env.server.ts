import 'server-only';
import { z } from 'zod';

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
});

export type ServerEnv = z.infer<typeof serverSchema> & { cookieSecure: boolean };

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
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
  };
  return cached;
}
