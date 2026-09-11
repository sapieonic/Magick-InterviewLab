'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireAdmin } from '@/features/auth/guards';
import { hashPassword } from '@/features/auth/password';
import { destroyAllSessionsFor } from '@/features/auth/session';
import { sendCandidateWelcomeEmail, type WelcomeEmailStatus } from './email';
import {
  createCandidateSchema,
  resetCandidatePasswordSchema,
  setCandidateActiveSchema,
  updateCandidateSchema,
} from '@/lib/validation/schemas';

const DUPLICATE_EMAIL = 'A user with that email already exists.';

function revalidateCandidate(id?: string): void {
  revalidatePath('/admin');
  revalidatePath('/admin/candidates');
  if (id) revalidatePath(`/admin/candidates/${id}`);
}

/**
 * An admin must not be able to reach an *admin* account through the candidate
 * screens — a reset here always sets `mustChangePassword`, which would lock a
 * colleague out of their own console.
 */
async function requireCandidateRecord(id: string): Promise<{ id: string; email: string }> {
  const candidate = await prisma.user.findFirst({
    where: { id, role: 'CANDIDATE' },
    select: { id: true, email: true },
  });
  if (!candidate) throw new NotFoundError('Candidate');
  return candidate;
}

export interface CreatedCandidate {
  id: string;
  name: string;
  email: string;
  /** Outcome of the invitation email, so the admin knows whether to hand the
   *  password over themselves. Never a failure of the creation itself. */
  emailStatus: WelcomeEmailStatus;
}

/**
 * `sendCandidateWelcomeEmail`, with its contract enforced rather than trusted.
 * A thrown invitation must never cost the caller a created candidate.
 */
async function sendWelcome(
  input: Parameters<typeof sendCandidateWelcomeEmail>[0],
): Promise<WelcomeEmailStatus> {
  try {
    return await sendCandidateWelcomeEmail(input);
  } catch (error) {
    console.error('[candidates] welcome email threw past its own guard', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}

export async function createCandidateAction(
  _prev: ActionResult<CreatedCandidate> | null,
  formData: FormData,
): Promise<ActionResult<CreatedCandidate>> {
  return actionGuard(async () => {
    await requireAdmin();

    const rawInterviewId = String(formData.get('interviewId') ?? '').trim();
    const input = createCandidateSchema.parse({
      name: formData.get('name'),
      email: formData.get('email'),
      temporaryPassword: formData.get('temporaryPassword'),
      interviewId: rawInterviewId === '' ? undefined : rawInterviewId,
      sendWelcomeEmail: formData.get('sendWelcomeEmail') === 'true',
    });

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) throw new AppError(DUPLICATE_EMAIL, { email: [DUPLICATE_EMAIL] });

    let assignedInterview: { title: string; durationMinutes: number | null } | undefined;
    if (input.interviewId) {
      const interview = await prisma.interview.findUnique({
        where: { id: input.interviewId },
        // `durationMinutes` rides along for the email: opening the workspace
        // starts a countdown that is never reset, so an invitation that does
        // not mention it can cost a candidate their window.
        select: { id: true, title: true, durationMinutes: true },
      });
      if (!interview) {
        throw new AppError('That interview no longer exists.', {
          interviewId: ['That interview no longer exists.'],
        });
      }
      assignedInterview = { title: interview.title, durationMinutes: interview.durationMinutes };
    }

    const candidate = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash: await hashPassword(input.temporaryPassword),
        role: 'CANDIDATE',
        // Every admin-chosen password is temporary by definition: the admin
        // knows it, so the candidate must replace it before doing anything.
        mustChangePassword: true,
        ...(input.interviewId
          ? { assignments: { create: { interviewId: input.interviewId } } }
          : {}),
      },
      select: { id: true, name: true, email: true },
    });

    // Deliberately after the commit and deliberately not awaited *inside* a
    // transaction: the account is real from this point on, so a mail provider
    // that is down degrades to the hand-over flow this feature replaces
    // rather than failing a creation that has already happened.
    //
    // The try/catch is here as well as inside `sendCandidateWelcomeEmail`
    // because this is the frame that owns the committed row. Relying on the
    // callee's "never throws" docblock makes the invariant a convention: one
    // escape and `actionGuard` turns a created account into "Something went
    // wrong", with the plaintext password lost from the only screen that
    // would ever have shown it.
    const emailStatus = await sendWelcome({
      name: candidate.name,
      email: candidate.email,
      temporaryPassword: input.temporaryPassword,
      ...(assignedInterview ? { interviewTitle: assignedInterview.title } : {}),
      ...(assignedInterview?.durationMinutes
        ? { interviewDurationMinutes: assignedInterview.durationMinutes }
        : {}),
      requested: input.sendWelcomeEmail,
    });

    revalidateCandidate(candidate.id);
    if (input.interviewId) revalidatePath(`/admin/interviews/${input.interviewId}`);

    // The plaintext password is deliberately NOT echoed back: the browser
    // that submitted it already has it, and returning it would put it in the
    // action result, the RSC payload and any error reporting downstream. The
    // email status is a slug for the same reason.
    return ok({ ...candidate, emailStatus });
  });
}

export async function updateCandidateAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireAdmin();

    const input = updateCandidateSchema.parse({
      id: formData.get('id'),
      name: formData.get('name'),
      email: formData.get('email'),
    });

    await requireCandidateRecord(input.id);

    const clash = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (clash && clash.id !== input.id) {
      throw new AppError(DUPLICATE_EMAIL, { email: [DUPLICATE_EMAIL] });
    }

    await prisma.user.update({
      where: { id: input.id },
      data: { name: input.name, email: input.email },
    });

    revalidateCandidate(input.id);
    return ok();
  });
}

export async function resetCandidatePasswordAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireAdmin();

    const input = resetCandidatePasswordSchema.parse({
      id: formData.get('id'),
      temporaryPassword: formData.get('temporaryPassword'),
    });

    await requireCandidateRecord(input.id);

    await prisma.user.update({
      where: { id: input.id },
      data: {
        passwordHash: await hashPassword(input.temporaryPassword),
        mustChangePassword: true,
      },
    });

    // A reset exists precisely because the old credential is suspect; a live
    // cookie would otherwise keep working with the password we just revoked.
    await destroyAllSessionsFor(input.id);

    revalidateCandidate(input.id);
    return ok();
  });
}

export async function setCandidateActiveAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireAdmin();

    const input = setCandidateActiveSchema.parse({
      id: formData.get('id'),
      isActive: formData.get('isActive') === 'true',
    });

    await requireCandidateRecord(input.id);

    await prisma.user.update({ where: { id: input.id }, data: { isActive: input.isActive } });

    // `getCurrentUser` already refuses an inactive user, but deleting the
    // rows means a re-activation cannot silently resurrect an old session.
    if (!input.isActive) await destroyAllSessionsFor(input.id);

    revalidateCandidate(input.id);
    return ok();
  });
}
