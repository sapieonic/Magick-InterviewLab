'use server';

import 'server-only';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { changePasswordSchema, loginSchema } from '@/lib/validation/schemas';
import { hashPassword, verifyPassword } from './password';
import { createSession, destroyAllSessionsFor, destroySession } from './session';
import { homePathFor, requireUser } from './guards';
import { ensureBootstrapAdmin } from './bootstrap';

/**
 * A deliberately expensive no-op used when the account does not exist, so the
 * response time of "unknown email" matches "wrong password". Without it, login
 * timing enumerates which emails are registered.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZTEy$Yx0nWzTfxL2t9k0hCa1IEdG1u8mZ0kQ6ZVQ5c1cQKfw';

const GENERIC_LOGIN_FAILURE = 'Incorrect email or password.';

export async function loginAction(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never> | null> {
  const result = await actionGuard<never>(async () => {
    // First login of a fresh deployment should just work.
    await ensureBootstrapAdmin().catch((e) => console.error('[bootstrap]', e));

    const parsed = loginSchema.safeParse({
      email: formData.get('email'),
      password: formData.get('password'),
      next: formData.get('next') ?? undefined,
    });
    if (!parsed.success) throw new AppError(GENERIC_LOGIN_FAILURE);

    const { email, password, next } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      await verifyPassword(DUMMY_HASH, password);
      throw new AppError(GENERIC_LOGIN_FAILURE);
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) throw new AppError(GENERIC_LOGIN_FAILURE);

    // Checked *after* the password so an attacker cannot probe which accounts
    // exist but are disabled.
    if (!user.isActive) {
      throw new AppError('This account is inactive. Contact your administrator.');
    }

    const ua = (await headers()).get('user-agent') ?? undefined;
    await createSession(user.id, ua);
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const destination = safeRedirect(next) ?? homePathFor(user);
    redirect(destination);
  });
  return result.ok ? null : result;
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect('/login');
}

export async function changePasswordAction(
  _prev: ActionResult<never> | null,
  formData: FormData,
): Promise<ActionResult<never> | null> {
  const result = await actionGuard<never>(async () => {
    const actor = await requireUser();
    const parsed = changePasswordSchema.safeParse({
      currentPassword: formData.get('currentPassword'),
      newPassword: formData.get('newPassword'),
      confirmPassword: formData.get('confirmPassword'),
    });
    if (!parsed.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        (fieldErrors[issue.path.join('.') || '_'] ??= []).push(issue.message);
      }
      throw new AppError('Please correct the highlighted fields.', fieldErrors);
    }

    const user = await prisma.user.findUnique({ where: { id: actor.id } });
    if (!user) throw new AppError('Your account no longer exists.');

    const valid = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!valid) {
      throw new AppError('Incorrect current password.', {
        currentPassword: ['Incorrect current password.'],
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(parsed.data.newPassword),
        mustChangePassword: false,
      },
    });

    // Every other device is now logged out; then re-issue for this one.
    await destroyAllSessionsFor(user.id);
    await createSession(user.id, (await headers()).get('user-agent') ?? undefined);

    redirect(homePathFor({ role: user.role, mustChangePassword: false }));
  });
  return result.ok ? null : result;
}

/** Only same-origin absolute paths — never an attacker-supplied URL. */
function safeRedirect(next: string | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

export async function bootstrapAdminAction(): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await ensureBootstrapAdmin();
    return ok();
  });
}
