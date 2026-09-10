import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { Language as RuntimeLanguage } from '@/features/execution/types';
import { toRuntimeLanguage } from './language';
import type {
  AssignmentSummary,
  QuestionNavItem,
  WorkspaceData,
  WorkspaceQuestion,
} from './view-model';

/**
 * Every read here is scoped by `candidateId` in the WHERE clause — never
 * fetched first and checked afterwards. A candidate guessing another
 * candidate's assignment id gets zero rows, which the caller turns into a
 * 404; there is no code path where "found but not yours" exists to leak.
 */

function readStarterCode(
  value: unknown,
  supported: readonly RuntimeLanguage[],
): Partial<Record<RuntimeLanguage, string>> {
  const out: Partial<Record<RuntimeLanguage, string>> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  const record = value as Record<string, unknown>;
  for (const language of supported) {
    const code = record[language];
    if (typeof code === 'string' && code.trim() !== '') out[language] = code;
  }
  return out;
}

interface QuestionProgress {
  submissionCount: number;
  bestScore: number | null;
}

/** Best score wins, not latest: a candidate is judged on their best attempt. */
function progressFor(
  map: Map<string, QuestionProgress>,
  questionId: string,
): QuestionProgress {
  return map.get(questionId) ?? { submissionCount: 0, bestScore: null };
}

async function loadProgress(
  candidateId: string,
  interviewIds: string[],
): Promise<{ progress: Map<string, QuestionProgress>; drafted: Set<string> }> {
  const progress = new Map<string, QuestionProgress>();
  const drafted = new Set<string>();
  if (interviewIds.length === 0) return { progress, drafted };

  const [submissions, drafts] = await Promise.all([
    prisma.submission.findMany({
      where: { candidateId, interviewId: { in: interviewIds } },
      select: { questionId: true, score: true },
    }),
    prisma.codeDraft.findMany({
      where: { candidateId },
      select: { questionId: true },
    }),
  ]);

  for (const submission of submissions) {
    const current = progress.get(submission.questionId);
    if (current) {
      current.submissionCount += 1;
      current.bestScore = Math.max(current.bestScore ?? 0, submission.score);
    } else {
      progress.set(submission.questionId, {
        submissionCount: 1,
        bestScore: submission.score,
      });
    }
  }
  for (const draft of drafts) drafted.add(draft.questionId);

  return { progress, drafted };
}

/** The candidate home: every interview assigned to them, with per-question state. */
export async function listCandidateAssignments(candidateId: string): Promise<AssignmentSummary[]> {
  const assignments = await prisma.interviewAssignment.findMany({
    where: { candidateId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: {
      interview: {
        include: {
          questions: {
            orderBy: { position: 'asc' },
            include: {
              question: { select: { id: true, title: true, difficulty: true } },
            },
          },
        },
      },
    },
  });

  const { progress, drafted } = await loadProgress(
    candidateId,
    assignments.map((a) => a.interviewId),
  );

  return assignments.map((assignment) => ({
    assignment: {
      id: assignment.id,
      status: assignment.status,
      startedAt: assignment.startedAt?.getTime() ?? null,
      completedAt: assignment.completedAt?.getTime() ?? null,
    },
    interview: {
      id: assignment.interview.id,
      title: assignment.interview.title,
      description: assignment.interview.description,
      durationMinutes: assignment.interview.durationMinutes,
      allowMultipleSubmissions: assignment.interview.allowMultipleSubmissions,
    },
    questions: assignment.interview.questions.map<QuestionNavItem>((link, index) => {
      const state = progressFor(progress, link.questionId);
      return {
        id: link.question.id,
        title: link.question.title,
        position: index + 1,
        difficulty: link.question.difficulty,
        hasDraft: drafted.has(link.questionId),
        submissionCount: state.submissionCount,
        bestScore: state.bestScore,
      };
    }),
  }));
}

/**
 * Flip ASSIGNED -> IN_PROGRESS the first time the workspace is opened.
 *
 * `updateMany` with the full predicate makes this idempotent and race-free:
 * two tabs opening at once produce one write and one no-op, and an assignment
 * that is not this candidate's simply matches nothing. `startedAt` is the
 * anchor the timer counts from, so it must be stamped exactly once.
 */
export async function startAssignmentIfNeeded(
  candidateId: string,
  assignmentId: string,
): Promise<void> {
  await prisma.interviewAssignment.updateMany({
    where: { id: assignmentId, candidateId, status: 'ASSIGNED' },
    data: { status: 'IN_PROGRESS', startedAt: new Date() },
  });
}

/**
 * Everything the workspace needs, or null if this candidate has no business
 * seeing it — including the case where the question is real but belongs to a
 * different interview than the one they were assigned.
 */
export async function loadWorkspace(
  candidateId: string,
  assignmentId: string,
  questionId: string,
): Promise<WorkspaceData | null> {
  const assignment = await prisma.interviewAssignment.findFirst({
    where: { id: assignmentId, candidateId },
    include: {
      interview: {
        include: {
          questions: {
            orderBy: { position: 'asc' },
            include: {
              question: { select: { id: true, title: true, difficulty: true } },
            },
          },
        },
      },
    },
  });
  if (!assignment) return null;

  const index = assignment.interview.questions.findIndex((q) => q.questionId === questionId);
  // The question exists but is not on this interview: same answer as "no such
  // question", so the URL cannot be used to enumerate the question bank.
  if (index === -1) return null;

  const [question, drafts, submissions, progressState] = await Promise.all([
    prisma.question.findUnique({
      where: { id: questionId },
      include: { testCases: { orderBy: { position: 'asc' } } },
    }),
    prisma.codeDraft.findMany({
      where: { candidateId, questionId },
      select: { language: true, sourceCode: true, updatedAt: true },
    }),
    prisma.submission.findMany({
      where: { candidateId, interviewId: assignment.interviewId, questionId },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true,
        language: true,
        score: true,
        passedCount: true,
        totalCount: true,
        submittedAt: true,
      },
    }),
    loadProgress(candidateId, [assignment.interviewId]),
  ]);
  if (!question) return null;

  const supportedLanguages = question.supportedLanguages.map(toRuntimeLanguage);
  const workspaceQuestion: WorkspaceQuestion = {
    id: question.id,
    title: question.title,
    description: question.description,
    difficulty: question.difficulty,
    position: index + 1,
    // An empty list would leave the candidate with no editor at all; the
    // schema default is both languages, so fall back to that rather than
    // rendering a dead page.
    supportedLanguages: supportedLanguages.length > 0 ? supportedLanguages : ['javascript'],
    starterCode: readStarterCode(question.starterCode, supportedLanguages),
    timeLimitMs: question.timeLimitMs,
    testCases: question.testCases.map((test) => ({
      id: test.id,
      input: test.input,
      expectedOutput: test.expectedOutput,
      description: test.description,
      weight: test.weight,
    })),
  };

  return {
    assignment: {
      id: assignment.id,
      status: assignment.status,
      startedAt: assignment.startedAt?.getTime() ?? null,
      completedAt: assignment.completedAt?.getTime() ?? null,
    },
    interview: {
      id: assignment.interview.id,
      title: assignment.interview.title,
      description: assignment.interview.description,
      durationMinutes: assignment.interview.durationMinutes,
      allowMultipleSubmissions: assignment.interview.allowMultipleSubmissions,
    },
    question: workspaceQuestion,
    questions: assignment.interview.questions.map<QuestionNavItem>((link, position) => {
      const state = progressFor(progressState.progress, link.questionId);
      return {
        id: link.question.id,
        title: link.question.title,
        position: position + 1,
        difficulty: link.question.difficulty,
        hasDraft: progressState.drafted.has(link.questionId),
        submissionCount: state.submissionCount,
        bestScore: state.bestScore,
      };
    }),
    drafts: drafts.map((draft) => ({
      language: toRuntimeLanguage(draft.language),
      sourceCode: draft.sourceCode,
      updatedAt: draft.updatedAt.getTime(),
    })),
    submissions: submissions.map((submission) => ({
      id: submission.id,
      language: toRuntimeLanguage(submission.language),
      score: submission.score,
      passedCount: submission.passedCount,
      totalCount: submission.totalCount,
      submittedAt: submission.submittedAt.getTime(),
    })),
  };
}
