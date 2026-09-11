import 'server-only';
import {
  parseStoredResults,
  type ParsedResults,
  type StoredTestResult,
} from '@/features/submissions/stored-results';

export { parseStoredResults };
export type { ParsedResults, StoredTestResult };
import { prisma } from '@/lib/db/prisma';
import {
  getSubmissionNotes,
  resolveSubmissionScope,
  type SubmissionNoteView,
} from '@/features/feedback/queries';
import type { SessionUser } from '@/features/auth/session';
import type { Language, SubmissionTrigger } from '@/generated/prisma/enums';

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
  trigger: SubmissionTrigger;
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
      trigger: true,
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

export interface SubmissionReview {
  submission: SubmissionDetail;
  notes: SubmissionNoteView[];
  /** The application this assessment is a round of, where there is one. */
  applicationId: string | null;
}

/**
 * The whole review surface for one submission, access-checked.
 *
 * The detail page used to be admin-only, so `getSubmission` never asked who
 * was reading. It is now open to any staff member who may see the owning
 * application — an interviewer on the panel of the coding round has to be able
 * to read the code they are scoring — so the access decision has to live with
 * the read rather than in the page, and both the submission and its notes come
 * back through the same gate or neither does.
 *
 * `null` means "no such submission" and "not yours" alike.
 */
export async function getSubmissionForReview(
  viewer: SessionUser,
  id: string,
): Promise<SubmissionReview | null> {
  const scope = await resolveSubmissionScope(viewer, id);
  if (!scope) return null;

  const [submission, notes] = await Promise.all([
    getSubmission(id),
    getSubmissionNotes(viewer, id),
  ]);
  if (!submission) return null;

  return { submission, notes, applicationId: scope.applicationId };
}
