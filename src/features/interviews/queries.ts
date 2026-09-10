import 'server-only';
import { prisma } from '@/lib/db/prisma';
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
  candidate: { id: string; name: string; email: string; isActive: boolean };
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
          candidate: { select: { id: true, name: true, email: true, isActive: true } },
        },
      },
    },
  });

  if (!row) return null;

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
      candidate: a.candidate,
    })),
  };
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
