import 'server-only';
import {
  parseStoredResults,
  type ParsedResults,
  type StoredTestResult,
} from '@/features/submissions/stored-results';

export { parseStoredResults };
export type { ParsedResults, StoredTestResult };
import { prisma } from '@/lib/db/prisma';
import type { Language } from '@/generated/prisma/enums';

/**
 * Read models for submission review.
 *
 * These live beside the route rather than in `src/features/submissions/`
 * because that directory holds the shared scoring rules the candidate flow
 * also depends on, and the admin review screens are the only consumer here.
 */

export interface SubmissionListRow {
  id: string;
  score: number;
  passedCount: number;
  totalCount: number;
  language: Language;
  submittedAt: Date;
  candidate: { id: string; name: string; email: string };
  interview: { id: string; title: string };
  question: { id: string; title: string };
}

export interface SubmissionFilter {
  candidateId?: string | undefined;
  interviewId?: string | undefined;
}

export async function listSubmissions(
  filter: SubmissionFilter,
  limit = 200,
): Promise<SubmissionListRow[]> {
  return prisma.submission.findMany({
    where: {
      ...(filter.candidateId ? { candidateId: filter.candidateId } : {}),
      ...(filter.interviewId ? { interviewId: filter.interviewId } : {}),
    },
    orderBy: { submittedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      score: true,
      passedCount: true,
      totalCount: true,
      language: true,
      submittedAt: true,
      candidate: { select: { id: true, name: true, email: true } },
      interview: { select: { id: true, title: true } },
      question: { select: { id: true, title: true } },
    },
  });
}

export async function listSubmissionFilterOptions(): Promise<{
  candidates: Array<{ id: string; name: string; email: string }>;
  interviews: Array<{ id: string; title: string }>;
}> {
  const [candidates, interviews] = await Promise.all([
    prisma.user.findMany({
      where: { role: 'CANDIDATE', submissions: { some: {} } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    }),
    prisma.interview.findMany({
      where: { submissions: { some: {} } },
      orderBy: { title: 'asc' },
      select: { id: true, title: true },
    }),
  ]);
  return { candidates, interviews };
}

export interface SubmissionDetail {
  id: string;
  score: number;
  passedCount: number;
  totalCount: number;
  language: Language;
  sourceCode: string;
  submittedAt: Date;
  results: ParsedResults;
  candidate: { id: string; name: string; email: string; isActive: boolean };
  interview: { id: string; title: string };
  question: { id: string; title: string; difficulty: string; timeLimitMs: number };
}

export async function getSubmission(id: string): Promise<SubmissionDetail | null> {
  const row = await prisma.submission.findUnique({
    where: { id },
    select: {
      id: true,
      score: true,
      passedCount: true,
      totalCount: true,
      language: true,
      sourceCode: true,
      submittedAt: true,
      results: true,
      candidate: { select: { id: true, name: true, email: true, isActive: true } },
      interview: { select: { id: true, title: true } },
      question: { select: { id: true, title: true, difficulty: true, timeLimitMs: true } },
    },
  });

  if (!row) return null;
  return { ...row, results: parseStoredResults(row.results) };
}
