'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db/prisma';
import { requireCandidate } from '@/features/auth/guards';
import { actionGuard, AppError, NotFoundError } from '@/lib/errors';
import { ok, type ActionResult } from '@/lib/action-result';
import { createSubmissionSchema, saveDraftSchema } from '@/lib/validation/schemas';
import { scoreSubmission } from './score';
// A 'use server' module may only export async functions, so the result
// shapes live next to the other view models.
import type { CreateSubmissionResult, SaveDraftResult } from './view-model';

/**
 * Is this question actually reachable by this candidate?
 *
 * Both actions re-derive the answer from the database rather than trusting
 * anything the workspace sent. The page already authorised the candidate when
 * it rendered, but a Server Action is a public endpoint: a candidate can POST
 * a question id they were never assigned, and "the page checked" is not a
 * control on a request that never went through the page.
 */
async function assertQuestionAssigned(candidateId: string, questionId: string): Promise<void> {
  const link = await prisma.interviewQuestion.findFirst({
    where: { questionId, interview: { assignments: { some: { candidateId } } } },
    select: { id: true },
  });
  if (!link) throw new NotFoundError('Question');
}

export async function saveDraftAction(input: {
  questionId: string;
  language: string;
  sourceCode: string;
}): Promise<ActionResult<SaveDraftResult>> {
  return actionGuard(async () => {
    const candidate = await requireCandidate();
    const parsed = saveDraftSchema.parse(input);
    await assertQuestionAssigned(candidate.id, parsed.questionId);

    const draft = await prisma.codeDraft.upsert({
      where: {
        candidateId_questionId_language: {
          candidateId: candidate.id,
          questionId: parsed.questionId,
          language: parsed.language,
        },
      },
      create: {
        candidateId: candidate.id,
        questionId: parsed.questionId,
        language: parsed.language,
        sourceCode: parsed.sourceCode,
      },
      update: { sourceCode: parsed.sourceCode },
      select: { updatedAt: true },
    });

    // Nothing is revalidated. A draft is per-candidate, private, and already
    // present in the client that just typed it — no rendered page anywhere
    // shows it. This used to revalidate '/interview', which invalidated the
    // assignments list on every ~1.5s autosave burst for a change that list
    // does not display.
    return ok({ savedAt: draft.updatedAt.getTime() });
  });
}

export async function createSubmissionAction(input: {
  interviewId: string;
  questionId: string;
  language: string;
  sourceCode: string;
  results: unknown[];
}): Promise<ActionResult<CreateSubmissionResult>> {
  return actionGuard(async () => {
    const candidate = await requireCandidate();
    const parsed = createSubmissionSchema.parse(input);

    const assignment = await prisma.interviewAssignment.findFirst({
      where: { candidateId: candidate.id, interviewId: parsed.interviewId },
      select: { id: true, status: true },
    });
    if (!assignment) throw new NotFoundError('Interview');

    const link = await prisma.interviewQuestion.findFirst({
      where: { interviewId: parsed.interviewId, questionId: parsed.questionId },
      select: { id: true, question: { select: { supportedLanguages: true } } },
    });
    if (!link) throw new NotFoundError('Question');

    // The language is part of the payload, so it is the client's claim, not
    // the question's rule. Without this a candidate could file a Python
    // submission against a JavaScript-only question — nothing downstream
    // would reject it, and the transcript would record a language the
    // question was never authored for.
    if (!link.question.supportedLanguages.includes(parsed.language)) {
      throw new AppError('That language is not allowed for this question.');
    }

    const interview = await prisma.interview.findUnique({
      where: { id: parsed.interviewId },
      select: { allowMultipleSubmissions: true, status: true },
    });
    if (!interview) throw new NotFoundError('Interview');

    // An archived interview is retired. A stale tab holding an assignment
    // from before the archive must not keep writing to it.
    if (interview.status === 'ARCHIVED') {
      throw new AppError('This interview has been archived and is no longer accepting answers.');
    }

    if (!interview.allowMultipleSubmissions) {
      const existing = await prisma.submission.findFirst({
        where: {
          candidateId: candidate.id,
          interviewId: parsed.interviewId,
          questionId: parsed.questionId,
        },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(
          'This interview allows one submission per question, and yours is already recorded.',
        );
      }
    }

    // The authoritative weights come from the database. Whatever weight the
    // browser reported is discarded — see the note in score.ts.
    const authoritativeTests = await prisma.testCase.findMany({
      where: { questionId: parsed.questionId },
      select: { id: true, weight: true },
    });

    // The candidate ran real tests, but not one of the ids they reported is a
    // test this question currently has — the admin edited the question (which
    // re-keys its test cases) while this tab was open. Scoring by id would
    // silently record 0/N under a screen full of green rows, and a
    // single-submission interview would give no retry. Refuse instead, so the
    // candidate re-runs against the current tests rather than losing the
    // attempt to a race they could not see.
    if (authoritativeTests.length > 0 && parsed.results.length > 0) {
      const currentIds = new Set(authoritativeTests.map((t) => t.id));
      const anyMatch = parsed.results.some((r) => currentIds.has(r.testCaseId));
      if (!anyMatch) {
        throw new AppError(
          'This question changed while you were working on it. Re-run the tests and submit again.',
        );
      }
    }

    const breakdown = scoreSubmission(authoritativeTests, parsed.results);

    // Normalised to plain JSON: Prisma's Json input rejects `undefined`, and
    // the optional fields on a TestResult are exactly where it shows up.
    const resultsJson = parsed.results.map((result) => ({
      testCaseId: result.testCaseId,
      description: result.description ?? '',
      status: result.status,
      input: result.input,
      expectedOutput: result.expectedOutput,
      actualOutput: result.actualOutput,
      stderr: result.stderr ?? '',
      errorMessage: result.errorMessage ?? '',
      errorKind: result.errorKind ?? null,
      weight: result.weight,
      durationMs: result.durationMs,
    }));

    const submission = await prisma.submission.create({
      data: {
        candidateId: candidate.id,
        interviewId: parsed.interviewId,
        questionId: parsed.questionId,
        language: parsed.language,
        sourceCode: parsed.sourceCode,
        score: breakdown.score,
        passedCount: breakdown.passed,
        totalCount: breakdown.total,
        results: {
          tests: resultsJson,
          score: breakdown.score,
          earnedWeight: breakdown.earnedWeight,
          totalWeight: breakdown.totalWeight,
        },
      },
      select: { id: true },
    });

    const interviewCompleted = await completeAssignmentIfDone(
      candidate.id,
      parsed.interviewId,
      assignment.id,
    );

    // 'layout' so the question list, the nav rail and this workspace all pick
    // up the new submission in one pass.
    revalidatePath('/interview', 'layout');

    return ok({
      submissionId: submission.id,
      score: breakdown.score,
      passed: breakdown.passed,
      total: breakdown.total,
      interviewCompleted,
    });
  });
}

/**
 * An assignment is complete when every question on the interview has at least
 * one submission from this candidate. Computed from the rows rather than a
 * counter so a question added to a published interview reopens the
 * assignment instead of leaving it falsely COMPLETED.
 */
async function completeAssignmentIfDone(
  candidateId: string,
  interviewId: string,
  assignmentId: string,
): Promise<boolean> {
  const [questions, answered] = await Promise.all([
    prisma.interviewQuestion.findMany({ where: { interviewId }, select: { questionId: true } }),
    prisma.submission.findMany({
      where: { candidateId, interviewId },
      select: { questionId: true },
      distinct: ['questionId'],
    }),
  ]);

  if (questions.length === 0) return false;
  const done = new Set(answered.map((row) => row.questionId));
  if (!questions.every((question) => done.has(question.questionId))) return false;

  await prisma.interviewAssignment.updateMany({
    where: { id: assignmentId, candidateId, status: { not: 'COMPLETED' } },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  return true;
}
