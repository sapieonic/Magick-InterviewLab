import 'server-only';
import { prisma } from '@/lib/db/prisma';
import type { AssignmentStatus, InterviewStatus, Language } from '@/generated/prisma/enums';

/**
 * Read models for the admin candidate screens.
 *
 * Every select is explicit. A `select`-free query on `User` would hand a
 * Client Component the Argon2 hash the moment someone passes the row down as
 * a prop, so the shape is pinned here rather than left to the caller.
 */

export interface CandidateListRow {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  submissionCount: number;
  interviews: Array<{ id: string; title: string; status: InterviewStatus }>;
}

export async function listCandidates(): Promise<CandidateListRow[]> {
  const rows = await prisma.user.findMany({
    where: { role: 'CANDIDATE' },
    orderBy: [{ createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      _count: { select: { submissions: true } },
      assignments: {
        orderBy: { createdAt: 'asc' },
        select: { interview: { select: { id: true, title: true, status: true } } },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    submissionCount: row._count.submissions,
    interviews: row.assignments.map((a) => a.interview),
  }));
}

export interface CandidateAssignment {
  id: string;
  status: AssignmentStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  interview: {
    id: string;
    title: string;
    status: InterviewStatus;
    durationMinutes: number | null;
    questions: Array<{ id: string; title: string; position: number }>;
  };
}

export interface CandidateSubmission {
  id: string;
  score: number;
  passedCount: number;
  totalCount: number;
  language: Language;
  submittedAt: Date;
  question: { id: string; title: string };
  interview: { id: string; title: string };
}

export interface CandidateDetail {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  assignments: CandidateAssignment[];
  submissions: CandidateSubmission[];
}

export async function getCandidate(id: string): Promise<CandidateDetail | null> {
  const row = await prisma.user.findFirst({
    where: { id, role: 'CANDIDATE' },
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      mustChangePassword: true,
      lastLoginAt: true,
      createdAt: true,
      assignments: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          interview: {
            select: {
              id: true,
              title: true,
              status: true,
              durationMinutes: true,
              questions: {
                orderBy: { position: 'asc' },
                select: { position: true, question: { select: { id: true, title: true } } },
              },
            },
          },
        },
      },
      submissions: {
        orderBy: { submittedAt: 'desc' },
        select: {
          id: true,
          score: true,
          passedCount: true,
          totalCount: true,
          language: true,
          submittedAt: true,
          question: { select: { id: true, title: true } },
          interview: { select: { id: true, title: true } },
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    assignments: row.assignments.map((a) => ({
      id: a.id,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      createdAt: a.createdAt,
      interview: {
        id: a.interview.id,
        title: a.interview.title,
        status: a.interview.status,
        durationMinutes: a.interview.durationMinutes,
        questions: a.interview.questions.map((q) => ({
          id: q.question.id,
          title: q.question.title,
          position: q.position,
        })),
      },
    })),
    submissions: row.submissions,
  };
}

export interface QuestionProgress {
  questionId: string;
  title: string;
  attempts: number;
  bestScore: number | null;
}

export interface InterviewProgress {
  interviewId: string;
  answered: number;
  total: number;
  questions: QuestionProgress[];
}

/**
 * Progress is derived from the submissions already loaded for the detail
 * page rather than re-queried — one candidate's history is small, and a
 * second round trip would only add a way for the two views to disagree.
 */
export function computeProgress(
  assignments: readonly CandidateAssignment[],
  submissions: readonly CandidateSubmission[],
): InterviewProgress[] {
  return assignments.map((assignment) => {
    const questions = assignment.interview.questions.map((question) => {
      const relevant = submissions.filter(
        (s) => s.interview.id === assignment.interview.id && s.question.id === question.id,
      );
      const bestScore = relevant.reduce<number | null>(
        (best, s) => (best === null || s.score > best ? s.score : best),
        null,
      );
      return {
        questionId: question.id,
        title: question.title,
        attempts: relevant.length,
        bestScore,
      };
    });

    return {
      interviewId: assignment.interview.id,
      answered: questions.filter((q) => q.attempts > 0).length,
      total: questions.length,
      questions,
    };
  });
}

/** Interviews an admin may assign: archived ones are history, not work. */
export async function listAssignableInterviews(): Promise<
  Array<{ id: string; title: string; status: InterviewStatus }>
> {
  return prisma.interview.findMany({
    where: { status: { not: 'ARCHIVED' } },
    orderBy: [{ status: 'asc' }, { title: 'asc' }],
    select: { id: true, title: true, status: true },
  });
}
