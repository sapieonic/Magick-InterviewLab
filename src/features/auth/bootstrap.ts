import 'server-only';
import { prisma } from '@/lib/db/prisma';
import { serverEnv } from '@/lib/env.server';
import { hashPassword, isArgon2Hash } from './password';

/**
 * Create the environment-configured admin if it does not exist. Idempotent,
 * and deliberately never *updates* an existing admin: rotating a live admin's
 * password by editing an env var would be a silent takeover vector.
 */
export async function ensureBootstrapAdmin(): Promise<{ created: boolean; email?: string }> {
  const env = serverEnv();
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return { created: false };

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return { created: false, email };

  const passwordHash = await resolveAdminHash();
  if (!passwordHash) {
    console.warn(
      '[bootstrap] ADMIN_EMAIL is set but no ADMIN_PASSWORD_HASH (or dev ADMIN_PASSWORD). ' +
        'Admin account not created. Run: npm run hash-password',
    );
    return { created: false, email };
  }

  await prisma.user.create({
    data: {
      email,
      name: env.ADMIN_NAME,
      passwordHash,
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: false,
    },
  });
  console.info(`[bootstrap] Created admin account ${email}`);
  return { created: true, email };
}

async function resolveAdminHash(): Promise<string | null> {
  const env = serverEnv();
  const configured = env.ADMIN_PASSWORD_HASH?.trim();
  if (configured) {
    if (!isArgon2Hash(configured)) {
      throw new Error(
        'ADMIN_PASSWORD_HASH is not an Argon2 hash. Generate one with: npm run hash-password',
      );
    }
    return configured;
  }
  const plaintext = env.ADMIN_PASSWORD?.trim();
  if (!plaintext) return null;
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'ADMIN_PASSWORD (plaintext) is refused in production. Set ADMIN_PASSWORD_HASH instead.',
    );
  }
  return hashPassword(plaintext);
}
