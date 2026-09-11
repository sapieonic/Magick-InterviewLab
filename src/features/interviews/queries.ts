import 'server-only';
import { prisma } from '@/lib/db/prisma';
import {
  elapsedMs,
  rollUpSubmissions,
  type RollUpSubmission,
  type SubmissionRollUp,
} from '@/features/review/loop';
import type { AssignmentStatus, Difficulty, InterviewStatus } from '@/generated/prisma/enums';

export interface InterviewListRow {
  id: string;
  title: string;
  status: InterviewStatus;
  durationMinutes: number | null;
  updatedAt: Date;
  questionCount: number;
  candidateCount: number;
}

export async function listInterviews(): Promise<InterviewListRow[]> {
  const rows = await prisma.interview.findMany({
    orderBy: [{ updatedAt: 'desc' }],
    select: {
      id: true,
      title: true,
      status: true,
      durationMinutes: true,
      updatedAt: true,
      _count: { select: { questions: true, assignments: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    durationMinutes: row.durationMinutes,
    updatedAt: row.updatedAt,
    questionCount: row._count.questions,
    candidateCount: row._count.assignments,
  }));
}

export interface InterviewQuestionRow {
  linkId: string;
  position: number;
  question: {
    id: string;
    title: string;
    difficulty: Difficulty;
    testCount: number;
  };
}

export interface InterviewAssignedCandidate {
  assignmentId: string;
  status: AssignmentStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Wall clock between the two stamps above, or null until the sitting has
   *  both started and finished. Computed here, once, so the page cannot
   *  subtract two dates and reach a different answer from the review queue. */
  elapsedMs: number | null;
  candidate: { id: string; name: string; email: string; isActive: boolean };
  /**
   * The candidate's final answer per question, rolled up.
   *
   * `latest` rather than `best`, which is the same choice the review queue
   * defaults to: the last thing they left behind is the answer, and taking the
   * high-water mark would hide a regression — a candidate whose final edit
   * broke a passing test would read as their best attempt forever.
   *
   * Empty for anyone who has not submitted, and empty means `score: null`
   * rather than zero. Nobody who has not sat the assessment gets a percentage
   * printed against their name.
   */
  rollUp: SubmissionRollUp;
}

export interface InterviewDetail {
  id: string;
  title: string;
  description: string;
  status: InterviewStatus;
  durationMinutes: number | null;
  allowMultipleSubmissions: boolean;
  createdAt: Date;
  updatedAt: Date;
  submissionCount: number;
  questions: InterviewQuestionRow[];
  candidates: InterviewAssignedCandidate[];
}

export async function getInterview(id: string): Promise<InterviewDetail | null> {
  const row = await prisma.interview.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      durationMinutes: true,
      allowMultipleSubmissions: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { submissions: true } },
      questions: {
        orderBy: { position: 'asc' },
        select: {
          id: true,
          position: true,
          question: {
            select: {
              id: true,
              title: true,
              difficulty: true,
              _count: { select: { testCases: true } },
            },
          },
        },
      },
      assignments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          createdAt: true,
          // The assessment's own clock. `status` alone says a sitting finished
          // and never says when, or how long it took.
          startedAt: true,
          completedAt: true,
          candidate: { select: { id: true, name: true, email: true, isActive: true } },
        },
      },
    },
  });

  if (!row) return null;

  const submissionsByCandidate = await loadSubmissions(
    id,
    row.assignments.map((a) => a.candidate.id),
  );

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    durationMinutes: row.durationMinutes,
    allowMultipleSubmissions: row.allowMultipleSubmissions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submissionCount: row._count.submissions,
    questions: row.questions.map((q) => ({
      linkId: q.id,
      position: q.position,
      question: {
        id: q.question.id,
        title: q.question.title,
        difficulty: q.question.difficulty,
        testCount: q.question._count.testCases,
      },
    })),
    candidates: row.assignments.map((a) => ({
      assignmentId: a.id,
      status: a.status,
      createdAt: a.createdAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      elapsedMs: elapsedMs(a.startedAt, a.completedAt),
      candidate: a.candidate,
      rollUp: rollUpSubmissions(submissionsByCandidate.get(a.candidate.id) ?? [], 'latest'),
    })),
  };
}

/**
 * Every assigned candidate's attempts at this interview, in one query.
 *
 * One `IN` over the candidate ids rather than a query per row — the same
 * batching `summariseSubmissions` in `pipeline/queries.ts` and
 * `loadAutomatedRuns` in the scorecard read model use. A page that fans out per
 * candidate is fine with four of them and is a hundred round trips on the
 * cohort this screen exists to show.
 *
 * Scoped by `interviewId` as well, so a candidate who also sat three other
 * assessments contributes only the attempts this page is about.
 */
async function loadSubmissions(
  interviewId: string,
  candidateIds: readonly string[],
): Promise<Map<string, RollUpSubmission[]>> {
  const out = new Map<string, RollUpSubmission[]>();
  if (candidateIds.length === 0) return out;

  const rows = await prisma.submission.findMany({
    where: { interviewId, candidateId: { in: [...new Set(candidateIds)] } },
    orderBy: { submittedAt: 'asc' },
    // Never `sourceCode` and never `results`: this is a roster, and the code
    // behind a row is a screen of its own with its own access check.
    select: {
      candidateId: true,
      questionId: true,
      score: true,
      passedCount: true,
      totalCount: true,
      submittedAt: true,
      trigger: true,
      language: true,
    },
  });

  for (const row of rows) {
    const bucket = out.get(row.candidateId) ?? [];
    bucket.push(row);
    out.set(row.candidateId, bucket);
  }
  return out;
}

/** Everything an admin can drop into an interview, minus what is already in it. */
export async function listQuestionOptions(
  excludeIds: readonly string[] = [],
): Promise<Array<{ id: string; title: string; difficulty: Difficulty; testCount: number }>> {
  const rows = await prisma.question.findMany({
    where: excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : undefined,
    orderBy: [{ title: 'asc' }],
    select: {
      id: true,
      title: true,
      difficulty: true,
      _count: { select: { testCases: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    difficulty: r.difficulty,
    testCount: r._count.testCases,
  }));
}

export async function listCandidateOptions(
  excludeIds: readonly string[] = [],
): Promise<Array<{ id: string; name: string; email: string }>> {
  return prisma.user.findMany({
    where: {
      role: 'CANDIDATE',
      ...(excludeIds.length > 0 ? { id: { notIn: [...excludeIds] } } : {}),
    },
    orderBy: [{ name: 'asc' }],
    select: { id: true, name: true, email: true },
  });
}
