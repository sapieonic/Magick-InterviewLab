import 'server-only';
import { z } from 'zod';
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

const storedTestSchema = z.object({
  testCaseId: z.string().max(200).default(''),
  description: z.string().max(2000).optional(),
  status: z.enum(['passed', 'failed', 'error', 'timeout']).catch('error'),
  input: z.string().default(''),
  expectedOutput: z.string().default(''),
  actualOutput: z.string().default(''),
  stderr: z.string().optional(),
  errorMessage: z.string().optional(),
  errorKind: z.string().optional(),
  weight: z.number().catch(1),
  durationMs: z.number().catch(0),
});

/**
 * The `results` column is written by the candidate-side runner, so this
 * parses defensively and accepts both the bare array and the enveloped form.
 * A review screen that throws on an unexpected payload would hide the very
 * submission an admin is trying to look at.
 */
const storedResultsSchema = z.union([
  z.array(storedTestSchema),
  z.object({
    tests: z.array(storedTestSchema).catch([]),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    fatalError: z.string().optional(),
    executionTimeMs: z.number().optional(),
  }),
]);

export type StoredTestResult = z.infer<typeof storedTestSchema>;

export interface ParsedResults {
  tests: StoredTestResult[];
  stdout?: string | undefined;
  stderr?: string | undefined;
  fatalError?: string | undefined;
  executionTimeMs?: number | undefined;
  unreadable: boolean;
}

export function parseStoredResults(value: unknown): ParsedResults {
  const parsed = storedResultsSchema.safeParse(value);
  if (!parsed.success) {
    // An empty `{}` is the column default, i.e. "nothing recorded" rather
    // than corruption — don't cry wolf about it.
    const isDefault =
      value === null ||
      (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
    return { tests: [], unreadable: !isDefault };
  }
  if (Array.isArray(parsed.data)) return { tests: parsed.data, unreadable: false };
  return {
    tests: parsed.data.tests,
    stdout: parsed.data.stdout,
    stderr: parsed.data.stderr,
    fatalError: parsed.data.fatalError,
    executionTimeMs: parsed.data.executionTimeMs,
    unreadable: false,
  };
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
