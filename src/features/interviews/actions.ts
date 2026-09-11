'use server';

import 'server-only';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { requireCapability } from '@/features/auth/guards';
import {
  assignInterviewSchema,
  cuidSchema,
  interviewInputSchema,
  reorderQuestionsSchema,
} from '@/lib/validation/schemas';

function revalidateInterview(id?: string): void {
  revalidatePath('/admin');
  revalidatePath('/admin/interviews');
  if (id) revalidatePath(`/admin/interviews/${id}`);
}

function readInterviewForm(formData: FormData) {
  return interviewInputSchema.parse({
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    status: formData.get('status') ?? 'DRAFT',
    durationMinutes: formData.get('durationMinutes') ?? '',
    // An unchecked box submits nothing at all, which is the only way to tell
    // "off" from "untouched" in a plain form POST.
    allowMultipleSubmissions: formData.get('allowMultipleSubmissions') !== null,
  });
}

export async function createInterviewAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = readInterviewForm(formData);

    const interview = await prisma.interview.create({
      data: input,
      select: { id: true },
    });

    revalidateInterview(interview.id);
    // Straight into the editor: a new interview with no questions is not yet
    // a usable thing, and the next step is always "add questions".
    redirect(`/admin/interviews/${interview.id}`);
  });
}

export async function updateInterviewAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));
    const input = readInterviewForm(formData);

    const existing = await prisma.interview.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Interview');

    await prisma.interview.update({ where: { id }, data: input });

    revalidateInterview(id);
    revalidatePath('/admin/candidates');
    return ok();
  });
}

export async function archiveInterviewAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const id = cuidSchema.parse(formData.get('id'));

    const existing = await prisma.interview.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new NotFoundError('Interview');

    // Archiving rather than deleting: submissions reference the interview and
    // an interview that has been sat is a record, not a draft.
    await prisma.interview.update({ where: { id }, data: { status: 'ARCHIVED' } });

    revalidateInterview(id);
    revalidatePath('/admin/candidates');
    return ok();
  });
}

export async function addInterviewQuestionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const interviewId = cuidSchema.parse(formData.get('interviewId'));
    const questionId = cuidSchema.parse(formData.get('questionId'));

    const [interview, question, already] = await Promise.all([
      prisma.interview.findUnique({ where: { id: interviewId }, select: { id: true } }),
      prisma.question.findUnique({ where: { id: questionId }, select: { id: true } }),
      prisma.interviewQuestion.findUnique({
        where: { interviewId_questionId: { interviewId, questionId } },
        select: { id: true },
      }),
    ]);
    if (!interview) throw new NotFoundError('Interview');
    if (!question) throw new NotFoundError('Question');
    if (already) throw new AppError('That question is already in this interview.');

    const last = await prisma.interviewQuestion.findFirst({
      where: { interviewId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    await prisma.interviewQuestion.create({
      data: { interviewId, questionId, position: (last?.position ?? -1) + 1 },
    });

    revalidateInterview(interviewId);
    return ok();
  });
}

export async function removeInterviewQuestionAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const interviewId = cuidSchema.parse(formData.get('interviewId'));
    const questionId = cuidSchema.parse(formData.get('questionId'));

    const link = await prisma.interviewQuestion.findUnique({
      where: { interviewId_questionId: { interviewId, questionId } },
      select: { id: true },
    });
    if (!link) throw new NotFoundError('Question');

    const remaining = await prisma.interviewQuestion.findMany({
      where: { interviewId, NOT: { id: link.id } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });

    // Delete and re-number together: a gap in `position` is harmless today
    // but makes "question 3 of 5" read wrong the moment anything counts.
    await prisma.$transaction([
      prisma.interviewQuestion.delete({ where: { id: link.id } }),
      ...remaining.map((row, index) =>
        prisma.interviewQuestion.update({ where: { id: row.id }, data: { position: index } }),
      ),
    ]);

    revalidateInterview(interviewId);
    return ok();
  });
}

/**
 * Takes the whole ordered list rather than a "move up" delta: the client
 * already knows the order it wants, and writing it wholesale means a stale
 * tab cannot interleave two half-applied swaps.
 */
export async function reorderInterviewQuestionsAction(
  payload: unknown,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_CONTENT');
    const input = reorderQuestionsSchema.parse(payload);

    const existing = await prisma.interviewQuestion.findMany({
      where: { interviewId: input.interviewId },
      select: { id: true, questionId: true },
    });

    const byQuestion = new Map(existing.map((row) => [row.questionId, row.id]));
    if (input.questionIds.length !== existing.length) {
      throw new AppError('The question list changed while you were editing. Reload and retry.');
    }

    const updates = input.questionIds.map((questionId, index) => {
      const linkId = byQuestion.get(questionId);
      if (!linkId) {
        throw new AppError('The question list changed while you were editing. Reload and retry.');
      }
      return prisma.interviewQuestion.update({ where: { id: linkId }, data: { position: index } });
    });

    await prisma.$transaction(updates);

    revalidateInterview(input.interviewId);
    return ok();
  });
}

export async function assignInterviewAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_PIPELINE');
    const input = assignInterviewSchema.parse({
      candidateId: formData.get('candidateId'),
      interviewId: formData.get('interviewId'),
    });

    const [candidate, interview] = await Promise.all([
      prisma.user.findFirst({
        where: { id: input.candidateId, role: 'CANDIDATE' },
        select: { id: true },
      }),
      prisma.interview.findUnique({ where: { id: input.interviewId }, select: { id: true } }),
    ]);
    if (!candidate) throw new NotFoundError('Candidate');
    if (!interview) throw new NotFoundError('Interview');

    const already = await prisma.interviewAssignment.findUnique({
      where: {
        interviewId_candidateId: {
          interviewId: input.interviewId,
          candidateId: input.candidateId,
        },
      },
      select: { id: true },
    });
    if (already) throw new AppError('That candidate is already assigned to this interview.');

    await prisma.interviewAssignment.create({
      data: { interviewId: input.interviewId, candidateId: input.candidateId },
    });

    revalidateInterview(input.interviewId);
    revalidatePath('/admin/candidates');
    revalidatePath(`/admin/candidates/${input.candidateId}`);
    return ok();
  });
}

export async function unassignInterviewAction(
  _prev: ActionResult<undefined> | null,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    await requireCapability('MANAGE_PIPELINE');
    const input = assignInterviewSchema.parse({
      candidateId: formData.get('candidateId'),
      interviewId: formData.get('interviewId'),
    });

    // A pipeline round can be *backed* by this assignment, and the foreign key
    // is `ON DELETE SET NULL`: deleting the assignment silently blanks
    // `stages.assignmentId`. Nothing about the round changes visibly at the
    // moment it happens, which is what makes it dangerous — a coding round
    // whose assignment was `COMPLETED` reads as "awaiting feedback" everywhere
    // through `deriveCodingStageStatus`, and with the assignment gone it
    // reverts to "pending" for a round that was submitted days ago, taking the
    // code and the test results the panellist was reviewing with it.
    //
    // So this refuses rather than detaching. Detaching quietly is the bug;
    // detaching loudly is `deleteStageAction`'s job, where the round and its
    // panel go together and the removal is recorded against the application.
    const pinned = await prisma.stage.findFirst({
      where: {
        assignment: { is: { interviewId: input.interviewId, candidateId: input.candidateId } },
      },
      select: { name: true },
    });
    if (pinned) {
      throw new AppError(
        `That assessment backs the round "${pinned.name}" on this candidate's application. Remove that round first — unassigning here would leave the round pointing at nothing and reset the progress it is showing.`,
      );
    }

    const { count } = await prisma.interviewAssignment.deleteMany({
      where: { interviewId: input.interviewId, candidateId: input.candidateId },
    });
    if (count === 0) throw new NotFoundError('Assignment');

    revalidateInterview(input.interviewId);
    revalidatePath('/admin/candidates');
    revalidatePath(`/admin/candidates/${input.candidateId}`);
    return ok();
  });
}
