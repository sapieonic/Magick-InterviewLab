import 'server-only';
import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id parameters. OWASP's 2024 baseline (19 MiB, t=2, p=1) — comfortably
 * fast on a small server while remaining expensive to attack offline.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error('Password must not be empty');
  return hash(plaintext, OPTIONS);
}

/**
 * Constant-time-ish verification. Never throws on a malformed hash — a
 * corrupt row must read as "wrong password", not as a 500 that reveals the
 * account exists.
 */
export async function verifyPassword(digest: string, plaintext: string): Promise<boolean> {
  if (!digest || !plaintext) return false;
  try {
    return await verify(digest, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

export function isArgon2Hash(value: string): boolean {
  return /^\$argon2(id|i|d)\$/.test(value);
}
