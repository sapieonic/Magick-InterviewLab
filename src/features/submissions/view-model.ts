import type { Language as RuntimeLanguage } from '@/features/execution/types';
import type { AssignmentStatus, Difficulty } from '@/generated/prisma/enums';

/**
 * The shapes that cross the server/client boundary.
 *
 * Deliberately free of `Date`, `Decimal` and Prisma model types: everything a
 * Client Component receives has to survive serialisation, and a plain
 * epoch-millis number is easier to reason about than a Date that arrives as a
 * string on one path and a Date on another. Languages are already normalised
 * to the executor's lowercase spelling here, so no component downstream has
 * to think about the database enum.
 */

export interface TestCaseView {
  id: string;
  input: string;
  expectedOutput: string;
  description: string;
  weight: number;
}

export interface QuestionNavItem {
  id: string;
  title: string;
  position: number;
  difficulty: Difficulty;
  /** An autosaved buffer exists — the candidate has opened and typed something. */
  hasDraft: boolean;
  submissionCount: number;
  bestScore: number | null;
}

export interface WorkspaceQuestion {
  id: string;
  title: string;
  description: string;
  difficulty: Difficulty;
  position: number;
  supportedLanguages: RuntimeLanguage[];
  starterCode: Partial<Record<RuntimeLanguage, string>>;
  timeLimitMs: number;
  testCases: TestCaseView[];
}

export interface DraftView {
  language: RuntimeLanguage;
  sourceCode: string;
  /** Epoch millis, so the client can compare it against its localStorage copy. */
  updatedAt: number;
}

export interface SubmissionView {
  id: string;
  language: RuntimeLanguage;
  score: number;
  passedCount: number;
  totalCount: number;
  submittedAt: number;
}

export interface InterviewView {
  id: string;
  title: string;
  description: string;
  durationMinutes: number | null;
  allowMultipleSubmissions: boolean;
}

export interface AssignmentView {
  id: string;
  status: AssignmentStatus;
  startedAt: number | null;
  completedAt: number | null;
}

export interface AssignmentSummary {
  assignment: AssignmentView;
  interview: InterviewView;
  questions: QuestionNavItem[];
}

export interface WorkspaceData {
  assignment: AssignmentView;
  interview: InterviewView;
  questions: QuestionNavItem[];
  question: WorkspaceQuestion;
  drafts: DraftView[];
  submissions: SubmissionView[];
}

/** Returned by `saveDraftAction`. */
export interface SaveDraftResult {
  savedAt: number;
}

/** Returned by `createSubmissionAction` — the score the *server* recorded. */
export interface CreateSubmissionResult {
  submissionId: string;
  score: number;
  passed: number;
  total: number;
  interviewCompleted: boolean;
}
