import type { Language, SubmissionTrigger } from '@/generated/prisma/enums';

/**
 * The post-assessment loop, as pure data.
 *
 * The pipeline board answers "where is this candidate in the process". This
 * module answers the different question the review queue exists for: **what is
 * this application waiting on, and who is it waiting on.** A round can be
 * perfectly healthy on the board — in progress, nothing overdue — while the
 * thing actually blocking it is that nobody has opened the code yet.
 *
 * Deliberately free of `server-only`, Prisma and `next` imports, for the reason
 * `capabilities.ts`, `feedback/visibility.ts` and `stage-status.ts` are: a rule
 * that can only be observed by running a page is a rule nobody can check.
 */

/**
 * Where an application sits in the loop, in the order the queue resolves them.
 *
 * Exactly one applies to any row — `deriveLoopStep` is total — and the order
 * below *is* the precedence. Two choices in it are worth stating:
 *
 *  - `UNREAD` outranks `PANEL`, because reading the code is the prerequisite
 *    for writing the scorecard. A row that is missing both is blocked on the
 *    first, and telling someone to chase a scorecard nobody can write yet is
 *    the wrong instruction.
 *  - `IN_FLIGHT` is the honest residue: the assessment is done and read,
 *    nothing is overdue, and a later round simply has not happened yet. It
 *    exists so the queue never has to bucket "nothing is wrong" under a label
 *    that says something is.
 */
export const REVIEW_LOOP_STEPS = [
  'CLOSED',
  'CLOSEOUT',
  'READY',
  'UNREAD',
  'PANEL',
  'IN_FLIGHT',
] as const;

export type ReviewLoopStep = (typeof REVIEW_LOOP_STEPS)[number];

export const LOOP_STEP_LABELS = {
  CLOSED: 'Closed',
  CLOSEOUT: 'Decided — to close out',
  READY: 'Ready to decide',
  UNREAD: 'Assessment done — unread',
  PANEL: 'Panel outstanding',
  IN_FLIGHT: 'Rounds in flight',
} as const satisfies Record<ReviewLoopStep, string>;

/** What each bucket means, for the filter bar's own description. */
export const LOOP_STEP_HINTS = {
  CLOSED: 'Hired, rejected or withdrawn. Nothing further is owed.',
  CLOSEOUT: 'A decision exists and the application is still open. The recruiter closes it.',
  READY: 'Every round is settled and no decision has been recorded.',
  UNREAD: 'The assessment is finished and no person has read the code yet.',
  PANEL: 'A round has run and a scorecard it is owed has not arrived.',
  IN_FLIGHT: 'Read, up to date, and waiting on a round that has not happened yet.',
} as const satisfies Record<ReviewLoopStep, string>;

/** The order the filter bar offers them: the work first, the archive last. */
export const LOOP_STEP_ORDER: readonly ReviewLoopStep[] = [
  'UNREAD',
  'PANEL',
  'READY',
  'CLOSEOUT',
  'IN_FLIGHT',
  'CLOSED',
];

export interface LoopStepInput {
  /** True for HIRED, REJECTED and WITHDRAWN — the application is over. */
  applicationClosed: boolean;
  hasDecision: boolean;
  /** Every round is COMPLETE or SKIPPED. */
  allStagesResolved: boolean;
  /** Has any person written a note on the code or submitted a scorecard on
   *  the coding round. A machine score nobody has read is not a review. */
  codeRead: boolean;
  outstandingScorecards: number;
}

export function deriveLoopStep(input: LoopStepInput): ReviewLoopStep {
  if (input.applicationClosed) return 'CLOSED';
  // Before `READY`, deliberately: an application with a decision is never
  // "ready to decide" again, even when a round is later reopened.
  if (input.hasDecision) return 'CLOSEOUT';
  if (input.allStagesResolved) return 'READY';
  if (!input.codeRead) return 'UNREAD';
  if (input.outstandingScorecards > 0) return 'PANEL';
  return 'IN_FLIGHT';
}

// --- the submission roll-up -------------------------------------------------

/**
 * Which submission per question the queue reports.
 *
 * `latest` is the default and is the candidate's *final answer*. `best` is
 * offered because a reviewer sometimes wants the high-water mark, and is not
 * the default because it hides a regression — a candidate whose last edit
 * broke a passing test reads as their best attempt forever.
 */
export type ReviewMetric = 'latest' | 'best';

export const REVIEW_METRICS: readonly ReviewMetric[] = ['latest', 'best'];

export function isReviewMetric(value: string): value is ReviewMetric {
  return (REVIEW_METRICS as readonly string[]).includes(value);
}

/** One submission, narrowed to what the roll-up needs. Never the source code. */
export interface RollUpSubmission {
  questionId: string;
  score: number;
  passedCount: number;
  totalCount: number;
  submittedAt: Date;
  trigger: SubmissionTrigger;
  language: Language;
}

export interface SubmissionRollUp {
  /** Tests passed across the chosen submission for each answered question. */
  passedCount: number;
  totalCount: number;
  /**
   * Mean of the chosen submissions' own percentages, or null when nothing has
   * been answered.
   *
   * A mean over questions rather than `passed/total`: questions carry
   * different numbers of tests, and summing the fractions would silently
   * weight a ten-test question five times a two-test one.
   */
  score: number | null;
  /** Every submission on this assessment, not just the chosen ones. */
  attempts: number;
  questionsAnswered: number;
  /** Chosen submissions the deadline produced rather than the candidate. */
  autoSubmitted: number;
  /** Languages actually used, for the language facet. */
  languages: Language[];
}

export const EMPTY_ROLL_UP: SubmissionRollUp = {
  passedCount: 0,
  totalCount: 0,
  score: null,
  attempts: 0,
  questionsAnswered: 0,
  autoSubmitted: 0,
  languages: [],
};

/**
 * Reduce every attempt on one assessment to one row.
 *
 * Ties go to the later submission under both metrics: two attempts scoring the
 * same means the candidate changed something without changing the outcome, and
 * the later one is still the answer they left behind.
 */
export function rollUpSubmissions(
  submissions: readonly RollUpSubmission[],
  metric: ReviewMetric,
): SubmissionRollUp {
  if (submissions.length === 0) return EMPTY_ROLL_UP;

  const chosenByQuestion = new Map<string, RollUpSubmission>();
  for (const row of submissions) {
    const current = chosenByQuestion.get(row.questionId);
    if (!current || beats(row, current, metric)) chosenByQuestion.set(row.questionId, row);
  }

  const chosen = [...chosenByQuestion.values()];
  return {
    passedCount: chosen.reduce((sum, row) => sum + row.passedCount, 0),
    totalCount: chosen.reduce((sum, row) => sum + row.totalCount, 0),
    score: Math.round(chosen.reduce((sum, row) => sum + row.score, 0) / chosen.length),
    attempts: submissions.length,
    questionsAnswered: chosen.length,
    autoSubmitted: chosen.filter((row) => row.trigger === 'AUTO_DEADLINE').length,
    languages: [...new Set(chosen.map((row) => row.language))].sort(),
  };
}

function beats(
  candidate: RollUpSubmission,
  incumbent: RollUpSubmission,
  metric: ReviewMetric,
): boolean {
  if (metric === 'best' && candidate.score !== incumbent.score) {
    return candidate.score > incumbent.score;
  }
  return candidate.submittedAt.getTime() >= incumbent.submittedAt.getTime();
}

// --- time -------------------------------------------------------------------

/**
 * Wall-clock elapsed on the assessment, or null when it has not both started
 * and finished.
 *
 * This is the only duration signal the schema actually carries, and it is wall
 * clock: it includes breaks, a closed laptop and a night's sleep. Everything
 * that renders it has to say so, and nothing may colour it, threshold it, or
 * compare it between candidates — see the README on why a duration styled as a
 * comparator is an accommodation problem rather than a weak metric.
 */
export function elapsedMs(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = completedAt.getTime() - startedAt.getTime();
  // A clock adjustment between the two stamps is the only way this goes
  // backwards. Report nothing rather than a negative duration.
  return ms >= 0 ? ms : null;
}

/**
 * How many of these submissions landed after the deadline.
 *
 * Zero for an untimed interview, and zero when the assessment was never
 * started — without `startedAt` there is no deadline to be late against, and
 * inventing one from `createdAt` would call every slow starter late.
 */
export function countLate(
  submissions: readonly RollUpSubmission[],
  startedAt: Date | null,
  durationMinutes: number | null,
): number {
  if (!startedAt || !durationMinutes) return 0;
  const deadline = startedAt.getTime() + durationMinutes * 60_000;
  return submissions.filter((row) => row.submittedAt.getTime() > deadline).length;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since `since`, or null when there is nothing to count from. */
export function daysSince(since: Date | null, now: Date): number | null {
  if (!since) return null;
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS));
}
