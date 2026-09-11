'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import { isStaff } from '@/features/auth/capabilities';
import { hashPassword } from '@/features/auth/password';
import { destroyAllSessionsFor } from '@/features/auth/session';
import { createStaffSchema, cuidSchema, updateUserRoleSchema } from '@/lib/validation/schemas';

/**
 * Staff accounts.
 *
 * Modelled on `features/candidates/actions.ts`, including the parts that look
 * like fussiness and are not: the admin chooses the first password, so it is
 * temporary by definition and `mustChangePassword` is set unconditionally; the
 * plaintext is never echoed back in the action result, never logged, and never
 * written anywhere but the browser that typed it.
 */

const DUPLICATE_EMAIL = 'A user with that email already exists.';

function revalidateStaff(): void {
  revalidatePath('/admin/settings');
  revalidatePath('/admin/pipeline');
}

export async function createStaffAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_USERS');

    const input = createStaffSchema.parse({
      name: formData.get('name'),
      email: formData.get('email'),
      role: formData.get('role'),
      temporaryPassword: formData.get('temporaryPassword'),
    });

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) throw new AppError(DUPLICATE_EMAIL, { email: [DUPLICATE_EMAIL] });

    await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: await hashPassword(input.temporaryPassword),
        role: input.role,
        // The admin knows this password, so the colleague must replace it
        // before doing anything. `requireCapability` enforces the same thing
        // at the action layer, not just at the page guard.
        mustChangePassword: true,
      },
      select: { id: true },
    });

    revalidateStaff();

    // Nothing about the password comes back, and there is no reveal panel of
    // the kind the candidate flow needs: the admin typed this password, it is
    // still in the field in front of them, and echoing it into the action
    // result would put a live credential in the RSC payload and in anything
    // downstream that reports on one. It is never logged either — the audit
    // trail for staff creation is the row itself.
    //
    // There is deliberately no invitation email. Staff are colleagues, handed
    // the password over whatever channel the team already trusts, and
    // `mustChangePassword` makes it worthless the moment they sign in.
    return ok();
  });
}

export async function setUserRoleAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_USERS');
    const input = updateUserRoleSchema.parse({
      id: formData.get('id'),
      role: formData.get('role'),
    });

    // The lockout. `MANAGE_USERS` belongs to admins alone, so an admin who
    // demotes themselves has just removed the only capability that could undo
    // it — and on a deployment with one admin, that is the console gone until
    // someone edits the database by hand. Another admin can do it; you cannot
    // do it to yourself.
    if (input.id === viewer.id) {
      throw new AppError(
        'You cannot change your own role. Ask another admin to do it — this is what stops an admin locking themselves out.',
      );
    }

    const target = await prisma.user.findUnique({
      where: { id: input.id },
      select: { id: true, role: true, name: true },
    });
    if (!target) throw new NotFoundError('User');

    // A candidate and a staff member are different shapes of person here: a
    // candidate owns assignments, drafts and submissions and is the *subject*
    // of applications; a staff member owns applications, panel seats and
    // scorecards. Flipping the role flips which half of the model is meant to
    // be populated and leaves the other half attached to an account that can
    // no longer reach it — a candidate's submissions stranded behind a console
    // they now have, or an interviewer's scorecards authored by someone the
    // system now treats as a candidate. If someone genuinely needs both, they
    // get two accounts.
    if (!isStaff(target.role)) {
      throw new AppError(
        `${target.name} is a candidate. A candidate account cannot become staff — create a separate staff account instead.`,
      );
    }

    if (target.role === input.role) return ok();

    await prisma.user.update({ where: { id: input.id }, data: { role: input.role } });

    // The session carries no capabilities of its own — they are read from the
    // role on every request — but a demotion should not leave someone sitting
    // on a page they may no longer use until they happen to navigate. Signing
    // them out makes the change take effect at the next click.
    await destroyAllSessionsFor(input.id);

    revalidateStaff();
    return ok();
  });
}

export async function setStaffActiveAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const viewer = await requireCapability('MANAGE_USERS');
    const id = cuidSchema.parse(formData.get('id'));
    const isActive = formData.get('isActive') === 'true';

    if (id === viewer.id) {
      throw new AppError('You cannot deactivate your own account.');
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, name: true },
    });
    if (!target) throw new NotFoundError('User');
    if (!isStaff(target.role)) {
      throw new AppError(
        `${target.name} is a candidate — manage them from the candidates screen, where a reset also handles their assignments.`,
      );
    }

    await prisma.user.update({ where: { id }, data: { isActive } });
    // `getCurrentUser` already refuses an inactive user, but deleting the rows
    // means a re-activation cannot silently resurrect an old session.
    if (!isActive) await destroyAllSessionsFor(id);

    revalidateStaff();
    return ok();
  });
}
